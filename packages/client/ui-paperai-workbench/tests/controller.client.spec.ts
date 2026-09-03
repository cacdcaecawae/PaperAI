import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { PaperAIWorkbenchController } from '../src/client/controller.ts'
import type {
  PaperAIDocumentOpenResult, PaperAIImportDocumentResult, PaperAIResourceList, PaperAISelectedNodeBuffer,
  PaperAIWorkbenchRemote,
} from '../src/client/types.ts'
import {
  COMMIT_0, COMMIT_1, COMMIT_2, COMMIT_3, COMMIT_4, DOCUMENT_ID,
  documentOpenResult, documentSnapshot, HIT_PACK_ID, HIT_PROPOSAL_MEMBER_ID,
  HIT_TEMPLATE_ID, NODE_HEADING, NODE_PARAGRAPH, RESOURCES, RESOURCE_ID,
  REVISION_2, REVISION_3, REVISION_4, SESSION_ID, successfulRemote,
  TEMPLATE_CATALOG, textNodeBuffer, WORKSPACE_ID,
} from './fixtures.client.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const REMOTE_FAILURE = {
  ok: false as const,
  error: { code: 'internal', message: 'Host unavailable', details: {} },
}

describe('PaperAIWorkbenchController', () => {
  it('rejects a superseded Workspace list response', async () => {
    const first = deferred<RemoteResult<PaperAIResourceList>>()
    const secondResources: PaperAIResourceList = { ...RESOURCES, resources: [] }
    const remote = successfulRemote()
    const list = vi.fn<PaperAIWorkbenchRemote['list']>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ ok: true, value: secondResources })
    remote.list = list
    const controller = new PaperAIWorkbenchController(remote)

    const stale = controller.loadResources(WORKSPACE_ID)
    await controller.loadResources(WORKSPACE_ID)
    first.resolve({ ok: true, value: RESOURCES })
    await stale

    expect(controller.resourceStore(WORKSPACE_ID).getSnapshot()).toMatchObject({
      phase: 'ready', resources: [],
    })
    expect(list).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('loads a cold resource tree once and keeps Host diagnostics retryable', async () => {
    const remote = successfulRemote()
    const list = vi.fn<PaperAIWorkbenchRemote['list']>()
      .mockRejectedValueOnce('wire unavailable')
      .mockResolvedValueOnce(REMOTE_FAILURE)
      .mockResolvedValue({ ok: true, value: RESOURCES })
    remote.list = list
    const controller = new PaperAIWorkbenchController(remote)

    await controller.ensureResources(WORKSPACE_ID)
    expect(controller.resourceStore(WORKSPACE_ID).getSnapshot()).toMatchObject({
      phase: 'error', error: 'remote-rejected: wire unavailable',
    })
    await controller.ensureResources(WORKSPACE_ID)
    expect(list).toHaveBeenCalledOnce()

    await controller.loadResources(WORKSPACE_ID)
    expect(controller.resourceStore(WORKSPACE_ID).getSnapshot()).toMatchObject({
      phase: 'error', error: 'internal: Host unavailable',
    })
    await controller.loadResources(WORKSPACE_ID)
    expect(controller.resourceStore(WORKSPACE_ID).getSnapshot().phase).toBe('ready')

    controller.failWorkspace(WORKSPACE_ID, new Error('Workspace failed'))
    expect(controller.resourceStore(WORKSPACE_ID).getSnapshot().error).toBe('Workspace failed')
    controller.failWorkspace(WORKSPACE_ID, 'Workspace unavailable')
    expect(controller.resourceStore(WORKSPACE_ID).getSnapshot().error).toBe('Workspace unavailable')
    controller.dispose()
    controller.dispose()
    expect(() => { controller.failWorkspace(WORKSPACE_ID, 'ignored') }).not.toThrow()
  })

  it('preserves existing resources across import errors, downgrade, mismatch, and supersession', async () => {
    const remote = successfulRemote()
    const controller = new PaperAIWorkbenchController(remote)
    await controller.loadResources(WORKSPACE_ID)
    const input = { fileName: 'proposal.docx', contentBase64: 'UEsDBAoAAAAA', role: 'proposal' as const }

    remote.importDocument = vi.fn<PaperAIWorkbenchRemote['importDocument']>()
      .mockResolvedValueOnce(REMOTE_FAILURE)
      .mockResolvedValueOnce({
        ok: true,
        value: { status: 'degraded', capability: 'document-engine', detail: 'OfficeCLI unavailable' },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          status: 'imported',
          opened: {
            ...documentOpenResult(),
            selectedNode: { ...textNodeBuffer(), baseRevision: REVISION_2 },
          },
          createdCommitId: COMMIT_1,
        },
      })

    await expect(controller.importDocument(WORKSPACE_ID, SESSION_ID, input)).resolves.toEqual({
      ok: false, error: 'internal: Host unavailable',
    })
    expect(controller.resourceStore(WORKSPACE_ID).getSnapshot().phase).toBe('ready')
    await expect(controller.importDocument(WORKSPACE_ID, SESSION_ID, input)).resolves.toEqual({
      ok: false, error: 'document-engine: OfficeCLI unavailable',
    })
    expect(controller.resourceStore(WORKSPACE_ID).getSnapshot().phase).toBe('ready')
    await expect(controller.importDocument(WORKSPACE_ID, SESSION_ID, input)).resolves.toEqual({
      ok: false,
      error: 'paperaiWorkbench returned an imported document for another Workspace or Session',
    })

    const pending = deferred<RemoteResult<PaperAIImportDocumentResult>>()
    remote.importDocument = vi.fn<PaperAIWorkbenchRemote['importDocument']>(() => pending.promise)
    const importing = controller.importDocument(WORKSPACE_ID, SESSION_ID, input)
    await controller.loadResources(WORKSPACE_ID)
    pending.resolve({
      ok: true,
      value: { status: 'imported', opened: documentOpenResult(), createdCommitId: COMMIT_1 },
    })
    await expect(importing).resolves.toEqual({ ok: true })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      phase: 'ready', action: null, document: { documentId: DOCUMENT_ID },
    })
    controller.dispose()
  })

  it('starts a template-backed document through the same establishing path as import', async () => {
    const remote = successfulRemote()
    const controller = new PaperAIWorkbenchController(remote)
    await controller.loadResources(WORKSPACE_ID)
    const createFromTemplate = vi.spyOn(remote, 'createFromTemplate')
    const input = { packId: HIT_PACK_ID, memberId: HIT_PROPOSAL_MEMBER_ID }

    await expect(controller.createFromTemplate(WORKSPACE_ID, SESSION_ID, input)).resolves.toEqual({ ok: true })
    expect(createFromTemplate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      packId: HIT_PACK_ID,
      memberId: HIT_PROPOSAL_MEMBER_ID,
    }, expect.any(AbortSignal))
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      phase: 'ready', action: null, document: { documentId: DOCUMENT_ID },
    })
    expect(controller.resourceStore(WORKSPACE_ID).getSnapshot()).toMatchObject({
      phase: 'ready', selected: RESOURCE_ID,
    })

    remote.createFromTemplate = vi.fn<PaperAIWorkbenchRemote['createFromTemplate']>()
      .mockResolvedValueOnce(REMOTE_FAILURE)
    await expect(controller.createFromTemplate(WORKSPACE_ID, SESSION_ID, {
      ...input,
      upload: { fileName: 'thesis.docx', contentBase64: 'UEsDBAoAAAAA' },
    })).resolves.toEqual({ ok: false, error: 'internal: Host unavailable' })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      phase: 'ready', action: null, actionError: 'internal: Host unavailable',
    })
    controller.dispose()
  })

  it('reads the built-in template choices and folds Host failures into one diagnostic', async () => {
    const remote = successfulRemote()
    const controller = new PaperAIWorkbenchController(remote)
    await expect(controller.templateChoices(WORKSPACE_ID)).resolves.toEqual({
      ok: true, packs: TEMPLATE_CATALOG.packs,
    })
    remote.listTemplates = vi.fn<PaperAIWorkbenchRemote['listTemplates']>()
      .mockResolvedValueOnce(REMOTE_FAILURE)
      .mockRejectedValueOnce(new Error('wire unavailable'))
    await expect(controller.templateChoices(WORKSPACE_ID)).resolves.toEqual({
      ok: false, error: 'internal: Host unavailable',
    })
    await expect(controller.templateChoices(WORKSPACE_ID)).resolves.toEqual({
      ok: false, error: 'remote-rejected: wire unavailable',
    })
    controller.dispose()
    await expect(controller.templateChoices(WORKSPACE_ID)).rejects.toThrow()
  })

  it('rejects stale and mismatched open projections without losing the latest open document', async () => {
    const remote = successfulRemote()
    const first = deferred<RemoteResult<ReturnType<typeof documentOpenResult>>>()
    remote.open = vi.fn<PaperAIWorkbenchRemote['open']>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult() })
    const controller = new PaperAIWorkbenchController(remote)
    await expect(controller.retryOpen(SESSION_ID)).resolves.toBeUndefined()
    const stale = controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    first.resolve({ ok: true, value: documentOpenResult() })
    await stale
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().phase).toBe('ready')

    controller.workbenchStore(SESSION_ID).update((state) => { state.action = 'validating' })
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().actionError)
      .toBe('wait for the current document action before opening another document')
    controller.dispose()

    const mismatches = [
      {
        ...documentOpenResult(),
        selectedNode: { ...textNodeBuffer(), baseCommitId: COMMIT_0 },
      },
      {
        ...documentOpenResult(),
        document: { ...documentSnapshot(), workspaceId: 'workspace-other' as typeof WORKSPACE_ID },
      },
      {
        ...documentOpenResult(),
        document: { ...documentSnapshot(), sessionId: 'session-other' as typeof SESSION_ID },
      },
      {
        ...documentOpenResult(),
        document: {
          ...documentSnapshot(),
          resourceId: 'resource-other' as typeof RESOURCE_ID,
        },
      },
    ]
    for (const value of mismatches) {
      const mismatchRemote = successfulRemote()
      mismatchRemote.open = vi.fn<PaperAIWorkbenchRemote['open']>()
        .mockResolvedValue({ ok: true, value })
      const mismatch = new PaperAIWorkbenchController(mismatchRemote)
      await mismatch.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
      expect(mismatch.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
        phase: 'error',
        error: 'paperaiWorkbench returned a node buffer from another document revision',
      })
      mismatch.dispose()
    }

    const withoutSelection = successfulRemote()
    withoutSelection.open = vi.fn<PaperAIWorkbenchRemote['open']>()
      .mockResolvedValue({
        ok: true,
        value: { document: documentSnapshot(), selectedNode: null },
      })
    const blank = new PaperAIWorkbenchController(withoutSelection)
    await blank.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    expect(blank.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      phase: 'ready', nodePhase: 'idle', selectedNode: null, draft: '',
    })
    blank.dispose()
  })

  it('imports one browser-selected Word file and opens its backed Working copy', async () => {
    const remote = successfulRemote()
    const importDocument = vi.spyOn(remote, 'importDocument')
    const list = vi.spyOn(remote, 'list')
    const controller = new PaperAIWorkbenchController(remote)

    await expect(controller.importDocument(WORKSPACE_ID, SESSION_ID, {
      fileName: 'proposal.docx',
      contentBase64: 'UEsDBAoAAAAA',
      role: 'proposal',
      name: 'Thesis proposal',
    })).resolves.toEqual({ ok: true })

    expect(importDocument).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      fileName: 'proposal.docx',
      contentBase64: 'UEsDBAoAAAAA',
      role: 'proposal',
      name: 'Thesis proposal',
    }, expect.any(AbortSignal))
    expect(list).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID }, expect.any(AbortSignal))
    expect(controller.resourceStore(WORKSPACE_ID).getSnapshot()).toMatchObject({
      phase: 'ready', selected: RESOURCE_ID, resources: RESOURCES.resources,
    })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      phase: 'ready',
      document: { documentId: DOCUMENT_ID, role: 'proposal' },
      selectedNode: { nodeId: NODE_HEADING },
    })
    controller.dispose()
  })

  it('never imports over a dirty node draft', async () => {
    const remote = successfulRemote()
    const importDocument = vi.spyOn(remote, 'importDocument')
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    controller.updateDraft(SESSION_ID, 'Keep this local draft')

    await expect(controller.importDocument(WORKSPACE_ID, SESSION_ID, {
      fileName: 'replacement.docx', contentBase64: 'UEsDBAoAAAAA', role: 'proposal',
    })).resolves.toEqual({
      ok: false,
      error: 'commit or discard the selected node draft before importing another document',
    })

    expect(importDocument).not.toHaveBeenCalled()
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      dirty: true,
      draft: 'Keep this local draft',
      action: null,
    })
    controller.dispose()
  })

  it('locks editing for the complete delayed import and publishes its result atomically', async () => {
    const pending = deferred<RemoteResult<PaperAIImportDocumentResult>>()
    const remote = successfulRemote()
    remote.importDocument = vi.fn<PaperAIWorkbenchRemote['importDocument']>(() => pending.promise)
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)

    const importing = controller.importDocument(WORKSPACE_ID, SESSION_ID, {
      fileName: 'replacement.docx', contentBase64: 'UEsDBAoAAAAA', role: 'proposal',
    })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().action).toBe('importing-document')
    controller.updateDraft(SESSION_ID, 'must not be accepted while importing')
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().draft).toBe('Editable thesis')
    await expect(controller.importDocument(WORKSPACE_ID, SESSION_ID, {
      fileName: 'second.docx', contentBase64: 'UEsDBAoAAAAA', role: 'proposal',
    })).resolves.toEqual({ ok: false, error: 'workbench is busy' })

    pending.resolve({
      ok: true,
      value: { status: 'imported', opened: documentOpenResult(), createdCommitId: COMMIT_1 },
    })
    await expect(importing).resolves.toEqual({ ok: true })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      phase: 'ready', action: null, dirty: false, draft: 'Editable thesis',
    })
    controller.dispose()
  })

  it('surfaces an explicit native document-engine downgrade without opening a document', async () => {
    const remote = successfulRemote()
    remote.importDocument = vi.fn<PaperAIWorkbenchRemote['importDocument']>()
      .mockResolvedValue({
        ok: true,
        value: {
          status: 'degraded',
          capability: 'legacy-doc-normalization',
          detail: 'Microsoft Word is unavailable',
        },
      })
    const controller = new PaperAIWorkbenchController(remote)

    await expect(controller.importDocument(WORKSPACE_ID, SESSION_ID, {
      fileName: 'legacy.doc', contentBase64: '0M8R4KGxGuE=', role: 'proposal',
    })).resolves.toEqual({
      ok: false,
      error: 'legacy-doc-normalization: Microsoft Word is unavailable',
    })
    expect(controller.resourceStore(WORKSPACE_ID).getSnapshot()).toMatchObject({
      phase: 'error', error: 'legacy-doc-normalization: Microsoft Word is unavailable',
    })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().phase).toBe('idle')
    controller.dispose()
  })

  it('rejects an imported projection owned by another Workspace', async () => {
    const remote = successfulRemote()
    const opened = documentOpenResult()
    remote.importDocument = vi.fn<PaperAIWorkbenchRemote['importDocument']>()
      .mockResolvedValue({
        ok: true,
        value: {
          status: 'imported',
          opened: {
            ...opened,
            document: {
              ...opened.document,
              workspaceId: 'workspace-other' as typeof WORKSPACE_ID,
            },
          },
          createdCommitId: COMMIT_1,
        },
      })
    const controller = new PaperAIWorkbenchController(remote)

    await expect(controller.importDocument(WORKSPACE_ID, SESSION_ID, {
      fileName: 'proposal.docx', contentBase64: 'UEsDBAoAAAAA', role: 'proposal',
    })).resolves.toEqual({
      ok: false,
      error: 'paperaiWorkbench returned an imported document for another Workspace or Session',
    })
    expect(controller.resourceStore(WORKSPACE_ID).getSnapshot()).toMatchObject({
      phase: 'error', selected: null,
    })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().document).toBeNull()
    controller.dispose()
  })

  it('commits exactly one selected-node mutation, creates a version, and preserves the tab', async () => {
    const remote = successfulRemote()
    const commit = vi.spyOn(remote, 'commit')
    const validate = vi.spyOn(remote, 'validate')
    const restore = vi.spyOn(remote, 'restore')
    const controller = new PaperAIWorkbenchController(remote)

    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    controller.selectTab(SESSION_ID, 'edit')
    controller.updateDraft(SESSION_ID, 'Rewritten introduction')
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().dirty).toBe(true)
    await expect(controller.commitSelected(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(commit).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      documentId: documentSnapshot().documentId,
      baseRevision: documentSnapshot().revision,
      baseCommitId: COMMIT_1,
      mutations: [{
        type: 'replace-text',
        nodeId: NODE_HEADING,
        baseText: 'Editable thesis',
        nextText: 'Rewritten introduction',
      }],
    }, expect.any(AbortSignal))
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      phase: 'ready',
      tab: 'edit',
      document: { revision: REVISION_2, headCommitId: COMMIT_2 },
      selectedNode: { baseRevision: REVISION_2, baseCommitId: COMMIT_2 },
      dirty: false,
    })

    await expect(controller.validate(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(validate).toHaveBeenCalledOnce()
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().document?.gate.status).toBe('passed')

    await expect(controller.restore(SESSION_ID, COMMIT_0)).resolves.toEqual({ ok: true })
    expect(restore).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      documentId: documentSnapshot().documentId,
      baseRevision: REVISION_2,
      baseCommitId: COMMIT_2,
      targetCommitId: COMMIT_0,
    }, expect.any(AbortSignal))
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().document).toMatchObject({
      revision: REVISION_3, headCommitId: COMMIT_3,
    })
    controller.dispose()
  })

  it('runs the template review, association, and two export modes through the Host', async () => {
    const remote = successfulRemote()
    const listTemplates = vi.spyOn(remote, 'listTemplates')
    const installTemplatePack = vi.spyOn(remote, 'installTemplatePack')
    const uploadTemplate = vi.spyOn(remote, 'uploadTemplate')
    const confirmTemplate = vi.spyOn(remote, 'confirmTemplate')
    const associateTemplate = vi.spyOn(remote, 'associateTemplate')
    const exportDocument = vi.spyOn(remote, 'exportDocument')
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)

    await expect(controller.loadTemplates(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(listTemplates).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().templates).toMatchObject({
      workspaceId: WORKSPACE_ID,
      contracts: [{
        templateId: HIT_TEMPLATE_ID,
        originPackId: HIT_PACK_ID,
        originMemberId: HIT_PROPOSAL_MEMBER_ID,
        requirements: [
          { ruleId: 'required-title', kind: 'required-field', enabled: true },
          { ruleId: 'heading-font', kind: 'font', enabled: true },
        ],
      }],
    })

    await expect(controller.installTemplate(
      SESSION_ID,
      HIT_PACK_ID,
      HIT_PROPOSAL_MEMBER_ID,
    )).resolves.toEqual({ ok: true })
    expect(installTemplatePack).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      packId: HIT_PACK_ID,
      memberIds: [HIT_PROPOSAL_MEMBER_ID],
    }, expect.any(AbortSignal))

    await expect(controller.uploadTemplate(SESSION_ID, {
      fileName: 'custom-proposal.docx',
      contentBase64: 'UEsDBAoAAAAA',
      name: 'Custom proposal template',
      usage: 'format-reference',
    })).resolves.toEqual({ ok: true })
    expect(uploadTemplate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      fileName: 'custom-proposal.docx',
      contentBase64: 'UEsDBAoAAAAA',
      name: 'Custom proposal template',
      appliesToRoles: ['proposal'],
      usage: 'format-reference',
    }, expect.any(AbortSignal))

    await expect(controller.confirmTemplate(SESSION_ID, HIT_TEMPLATE_ID)).resolves.toEqual({ ok: true })
    expect(confirmTemplate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      templateId: HIT_TEMPLATE_ID,
    })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().templates?.contracts[0]?.status)
      .toBe('confirmed')

    await expect(controller.associateTemplate(SESSION_ID, HIT_TEMPLATE_ID)).resolves.toEqual({ ok: true })
    expect(associateTemplate).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: documentSnapshot().revision,
      baseCommitId: COMMIT_1,
      templateId: HIT_TEMPLATE_ID,
    }, expect.any(AbortSignal))

    await expect(controller.exportDocument(SESSION_ID, 'draft-export')).resolves.toEqual({ ok: true })
    expect(exportDocument).toHaveBeenNthCalledWith(1, {
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: REVISION_2,
      baseCommitId: COMMIT_2,
      mode: 'draft-export',
    }, expect.any(AbortSignal))
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      document: { revision: REVISION_3, headCommitId: COMMIT_3 },
      exportReceipt: {
        mode: 'draft-export',
        fileName: 'Master-thesis-draft.docx',
        outputPath: 'F:/paper/outputs/Master-thesis-draft.docx',
      },
    })

    await expect(controller.exportDocument(SESSION_ID, 'delivery-export')).resolves.toEqual({ ok: true })
    expect(exportDocument).toHaveBeenNthCalledWith(2, {
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      baseRevision: REVISION_3,
      baseCommitId: COMMIT_3,
      mode: 'delivery-export',
    }, expect.any(AbortSignal))
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      document: { revision: REVISION_4, headCommitId: COMMIT_4, gate: { status: 'passed' } },
      exportReceipt: {
        mode: 'delivery-export',
        fileName: 'Master-thesis-delivery.docx',
        outputPath: 'F:/paper/outputs/Master-thesis-delivery.docx',
      },
    })
    controller.dispose()
  })

  it('projects a blocked formal export into the gate without creating a version or receipt', async () => {
    const remote = successfulRemote()
    remote.exportDocument = vi.fn<PaperAIWorkbenchRemote['exportDocument']>().mockResolvedValue({
      ok: true,
      value: {
        status: 'blocked',
        documentId: DOCUMENT_ID,
        revision: documentSnapshot().revision,
        headCommitId: COMMIT_1,
        fileName: 'Master-thesis-delivery.docx',
        gate: documentSnapshot().gate,
      },
    })
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)

    await expect(controller.exportDocument(SESSION_ID, 'delivery-export')).resolves.toEqual({
      ok: false,
      error: 'delivery blocked by 1 template requirement',
    })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      tab: 'gate',
      action: null,
      actionError: 'delivery blocked by 1 template requirement',
      exportReceipt: null,
      document: {
        revision: documentSnapshot().revision,
        headCommitId: COMMIT_1,
        gate: { status: 'failed' },
      },
    })
    controller.dispose()
  })

  it('preserves a dirty node draft and blocks template mutations, gates, and exports', async () => {
    const remote = successfulRemote()
    const validate = vi.spyOn(remote, 'validate')
    const installTemplatePack = vi.spyOn(remote, 'installTemplatePack')
    const uploadTemplate = vi.spyOn(remote, 'uploadTemplate')
    const confirmTemplate = vi.spyOn(remote, 'confirmTemplate')
    const associateTemplate = vi.spyOn(remote, 'associateTemplate')
    const exportDocument = vi.spyOn(remote, 'exportDocument')
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    controller.updateDraft(SESSION_ID, 'Unsaved proposal title')
    const locked = {
      ok: false as const,
      error: 'commit or discard the selected node draft before this action',
    }

    await expect(controller.validate(SESSION_ID)).resolves.toEqual(locked)
    await expect(controller.installTemplate(
      SESSION_ID,
      HIT_PACK_ID,
      HIT_PROPOSAL_MEMBER_ID,
    )).resolves.toEqual(locked)
    await expect(controller.uploadTemplate(SESSION_ID, {
      fileName: 'custom.docx',
      contentBase64: 'UEsDBAoAAAAA',
      name: 'Custom template',
      usage: 'format-reference',
    })).resolves.toEqual(locked)
    await expect(controller.confirmTemplate(SESSION_ID, HIT_TEMPLATE_ID)).resolves.toEqual(locked)
    await expect(controller.associateTemplate(SESSION_ID, HIT_TEMPLATE_ID)).resolves.toEqual(locked)
    await expect(controller.exportDocument(SESSION_ID, 'draft-export')).resolves.toEqual(locked)
    await expect(controller.exportDocument(SESSION_ID, 'delivery-export')).resolves.toEqual(locked)

    expect(validate).not.toHaveBeenCalled()
    expect(installTemplatePack).not.toHaveBeenCalled()
    expect(uploadTemplate).not.toHaveBeenCalled()
    expect(confirmTemplate).not.toHaveBeenCalled()
    expect(associateTemplate).not.toHaveBeenCalled()
    expect(exportDocument).not.toHaveBeenCalled()
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      dirty: true,
      draft: 'Unsaved proposal title',
      action: null,
      exportReceipt: null,
    })
    controller.dispose()
  })

  it('rejects a template catalog projected for another Workspace', async () => {
    const remote = successfulRemote()
    remote.listTemplates = vi.fn<PaperAIWorkbenchRemote['listTemplates']>()
      .mockResolvedValue({
        ok: true,
        value: {
          ...TEMPLATE_CATALOG,
          workspaceId: 'workspace-other' as typeof WORKSPACE_ID,
        },
      })
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)

    await expect(controller.loadTemplates(SESSION_ID)).resolves.toEqual({
      ok: false,
      error: 'paperaiWorkbench returned templates for another Workspace',
    })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      action: null,
      templates: null,
      actionError: 'paperaiWorkbench returned templates for another Workspace',
    })
    controller.dispose()
  })

  it('loads one node buffer and refuses to discard a dirty buffer through selection', async () => {
    const remote = successfulRemote()
    const readNode = vi.spyOn(remote, 'readNode')
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)

    await expect(controller.selectNode(SESSION_ID, NODE_PARAGRAPH)).resolves.toEqual({ ok: true })
    expect(readNode).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      documentId: documentSnapshot().documentId,
      nodeId: NODE_PARAGRAPH,
      revision: documentSnapshot().revision,
      headCommitId: COMMIT_1,
    }, expect.any(AbortSignal))
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().selectedNode).toMatchObject({
      nodeId: NODE_PARAGRAPH, format: 'text',
    })

    controller.updateDraft(SESSION_ID, 'Changed background')
    await expect(controller.selectNode(SESSION_ID, NODE_HEADING)).resolves.toEqual({
      ok: false, error: 'discard unsaved node changes before selecting another node',
    })
    expect(readNode).toHaveBeenCalledOnce()
    controller.discardDraft(SESSION_ID)
    await expect(controller.selectNode(SESSION_ID, NODE_HEADING)).resolves.toEqual({ ok: true })
    expect(readNode).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('enforces node-buffer and document-action prerequisites without Host calls', async () => {
    const remote = successfulRemote()
    const controller = new PaperAIWorkbenchController(remote)

    controller.updateDraft(SESSION_ID, 'ignored')
    controller.discardDraft(SESSION_ID)
    await expect(controller.selectNode(SESSION_ID, NODE_HEADING)).resolves.toEqual({
      ok: false, error: 'no open document',
    })
    await expect(controller.commitSelected(SESSION_ID)).resolves.toEqual({
      ok: false, error: 'no open document',
    })
    await expect(controller.validate(SESSION_ID)).resolves.toEqual({ ok: false, error: 'no open document' })
    await expect(controller.loadTemplates(SESSION_ID)).resolves.toEqual({ ok: false, error: 'no open document' })
    await expect(controller.installTemplate(SESSION_ID, HIT_PACK_ID, HIT_PROPOSAL_MEMBER_ID))
      .resolves.toEqual({ ok: false, error: 'no open document' })
    await expect(controller.uploadTemplate(SESSION_ID, {
      fileName: 'custom.docx', contentBase64: 'UEsDBAoAAAAA',
      name: 'Custom', usage: 'format-reference',
    })).resolves.toEqual({ ok: false, error: 'no open document' })
    await expect(controller.confirmTemplate(SESSION_ID, HIT_TEMPLATE_ID))
      .resolves.toEqual({ ok: false, error: 'no open document' })
    await expect(controller.associateTemplate(SESSION_ID, HIT_TEMPLATE_ID))
      .resolves.toEqual({ ok: false, error: 'no open document' })
    await expect(controller.exportDocument(SESSION_ID, 'draft-export'))
      .resolves.toEqual({ ok: false, error: 'no open document' })
    await expect(controller.exportDocument(SESSION_ID, 'delivery-export'))
      .resolves.toEqual({ ok: false, error: 'no open document' })
    await expect(controller.restore(SESSION_ID, COMMIT_0))
      .resolves.toEqual({ ok: false, error: 'no open document' })

    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    const store = controller.workbenchStore(SESSION_ID)
    await expect(controller.selectNode(SESSION_ID, NODE_HEADING)).resolves.toEqual({ ok: true })
    await expect(controller.selectNode(SESSION_ID, 'missing-node' as typeof NODE_HEADING)).resolves.toEqual({
      ok: false, error: 'selected node is not editable in the current document projection',
    })
    await expect(controller.selectNode(SESSION_ID, 'node-table' as typeof NODE_HEADING)).resolves.toEqual({
      ok: false, error: 'selected node is not editable in the current document projection',
    })
    await expect(controller.commitSelected(SESSION_ID)).resolves.toEqual({
      ok: false, error: 'selected node has no changes',
    })

    store.update((state) => { state.action = 'validating' })
    await expect(controller.selectNode(SESSION_ID, NODE_PARAGRAPH)).resolves.toEqual({
      ok: false, error: 'workbench is busy',
    })
    await expect(controller.commitSelected(SESSION_ID)).resolves.toEqual({
      ok: false, error: 'workbench is busy',
    })
    await expect(controller.loadTemplates(SESSION_ID)).resolves.toEqual({
      ok: false, error: 'workbench is busy',
    })
    await expect(controller.validate(SESSION_ID)).resolves.toEqual({
      ok: false, error: 'workbench is busy',
    })
    controller.updateDraft(SESSION_ID, 'ignored while busy')
    controller.discardDraft(SESSION_ID)
    store.update((state) => { state.action = null; state.nodePhase = 'loading' })
    await expect(controller.validate(SESSION_ID)).resolves.toEqual({
      ok: false, error: 'selected node buffer is loading',
    })
    controller.updateDraft(SESSION_ID, 'ignored while loading')

    store.update((state) => {
      state.nodePhase = 'idle'
      state.selectedNode = null
    })
    await expect(controller.commitSelected(SESSION_ID)).resolves.toEqual({
      ok: false, error: 'no selected node buffer',
    })
    controller.discardDraft(SESSION_ID)

    store.update((state) => {
      state.nodePhase = 'ready'
      state.selectedNode = { ...textNodeBuffer(), baseCommitId: COMMIT_0 }
      state.draft = 'Stale draft'
      state.dirty = true
    })
    await expect(controller.commitSelected(SESSION_ID)).resolves.toEqual({
      ok: false, error: 'selected node buffer is stale',
    })
    expect(store.getSnapshot().actionError).toBe('selected node buffer is stale')
    controller.dispose()
  })

  it('projects node read failures and rejects mismatched buffers', async () => {
    const results: Array<RemoteResult<PaperAISelectedNodeBuffer>> = [
      REMOTE_FAILURE,
      { ok: true, value: textNodeBuffer(undefined, 'Wrong node', NODE_HEADING) },
      {
        ok: true,
        value: { ...textNodeBuffer(undefined, 'Wrong revision', NODE_PARAGRAPH), baseRevision: REVISION_2 },
      },
    ]
    for (const result of results) {
      const remote = successfulRemote()
      remote.readNode = vi.fn<PaperAIWorkbenchRemote['readNode']>().mockResolvedValue(result)
      const controller = new PaperAIWorkbenchController(remote)
      await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
      const selected = await controller.selectNode(SESSION_ID, NODE_PARAGRAPH)
      expect(selected.ok).toBe(false)
      expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
        nodePhase: 'error', selectedNode: null,
      })
      controller.dispose()
    }
  })

  it('projects Remote failures for every template, export, validation, and restore action', async () => {
    const remote = successfulRemote()
    remote.validate = vi.fn<PaperAIWorkbenchRemote['validate']>().mockResolvedValue(REMOTE_FAILURE)
    remote.listTemplates = vi.fn<PaperAIWorkbenchRemote['listTemplates']>().mockResolvedValue(REMOTE_FAILURE)
    remote.installTemplatePack = vi.fn<PaperAIWorkbenchRemote['installTemplatePack']>()
      .mockResolvedValue(REMOTE_FAILURE)
    remote.uploadTemplate = vi.fn<PaperAIWorkbenchRemote['uploadTemplate']>().mockResolvedValue(REMOTE_FAILURE)
    remote.confirmTemplate = vi.fn<PaperAIWorkbenchRemote['confirmTemplate']>().mockResolvedValue(REMOTE_FAILURE)
    remote.associateTemplate = vi.fn<PaperAIWorkbenchRemote['associateTemplate']>()
      .mockResolvedValue(REMOTE_FAILURE)
    remote.exportDocument = vi.fn<PaperAIWorkbenchRemote['exportDocument']>().mockResolvedValue(REMOTE_FAILURE)
    remote.restore = vi.fn<PaperAIWorkbenchRemote['restore']>().mockResolvedValue(REMOTE_FAILURE)
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)

    const actions = [
      () => controller.validate(SESSION_ID),
      () => controller.loadTemplates(SESSION_ID),
      () => controller.installTemplate(SESSION_ID, HIT_PACK_ID, HIT_PROPOSAL_MEMBER_ID),
      () => controller.uploadTemplate(SESSION_ID, {
        fileName: 'custom.docx', contentBase64: 'UEsDBAoAAAAA',
        name: 'Custom', usage: 'format-reference',
      }),
      () => controller.confirmTemplate(SESSION_ID, HIT_TEMPLATE_ID),
      () => controller.associateTemplate(SESSION_ID, HIT_TEMPLATE_ID),
      () => controller.exportDocument(SESSION_ID, 'draft-export'),
      () => controller.restore(SESSION_ID, COMMIT_0),
    ]
    for (const action of actions) {
      await expect(action()).resolves.toEqual({ ok: false, error: 'internal: Host unavailable' })
      expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
        action: null, actionError: 'internal: Host unavailable',
      })
    }
    controller.dispose()
  })

  it('rejects validation, template, export, and restore projections for another document', async () => {
    const remote = successfulRemote()
    remote.validate = vi.fn<PaperAIWorkbenchRemote['validate']>().mockResolvedValue({
      ok: true,
      value: {
        documentId: 'document-other' as typeof DOCUMENT_ID,
        revision: documentSnapshot().revision,
        headCommitId: COMMIT_1,
        gate: { status: 'passed', findings: [] },
      },
    })
    const invalidCommit = {
      ...documentOpenResult(REVISION_2),
      document: {
        ...documentSnapshot(REVISION_2),
        documentId: 'document-other' as typeof DOCUMENT_ID,
      },
      createdCommitId: COMMIT_2,
    }
    remote.associateTemplate = vi.fn<PaperAIWorkbenchRemote['associateTemplate']>()
      .mockResolvedValue({ ok: true, value: invalidCommit })
    remote.exportDocument = vi.fn<PaperAIWorkbenchRemote['exportDocument']>()
      .mockResolvedValue({
        ok: true,
        value: {
          status: 'success',
          ...invalidCommit,
          outputPath: 'F:/paper/outputs/invalid.docx',
          fileName: 'invalid.docx',
          gate: { status: 'passed', findings: [] },
        },
      })
    remote.restore = vi.fn<PaperAIWorkbenchRemote['restore']>()
      .mockResolvedValue({ ok: true, value: invalidCommit })
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)

    await expect(controller.validate(SESSION_ID)).resolves.toEqual({
      ok: false, error: 'paperaiWorkbench returned a gate for another document revision',
    })
    await expect(controller.associateTemplate(SESSION_ID, HIT_TEMPLATE_ID)).resolves.toEqual({
      ok: false, error: 'paperaiWorkbench returned an invalid template commit projection',
    })
    await expect(controller.exportDocument(SESSION_ID, 'delivery-export')).resolves.toEqual({
      ok: false, error: 'paperaiWorkbench returned an invalid export commit projection',
    })
    await expect(controller.restore(SESSION_ID, COMMIT_0)).resolves.toEqual({
      ok: false, error: 'paperaiWorkbench returned an invalid restore projection',
    })
    controller.dispose()
  })

  it('rejects a superseded semantic-node response', async () => {
    const pending = deferred<RemoteResult<PaperAISelectedNodeBuffer>>()
    const remote = successfulRemote()
    remote.readNode = vi.fn<PaperAIWorkbenchRemote['readNode']>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ ok: true, value: textNodeBuffer() })
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)

    const stale = controller.selectNode(SESSION_ID, NODE_PARAGRAPH)
    await controller.selectNode(SESSION_ID, NODE_HEADING)
    pending.resolve({ ok: true, value: textNodeBuffer(undefined, 'Research background', NODE_PARAGRAPH) })
    await expect(stale).resolves.toEqual({ ok: false, error: 'request superseded' })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().selectedNode).toMatchObject({
      nodeId: NODE_HEADING, format: 'text',
    })
    controller.dispose()
  })

  it('does not lose a dirty node buffer through another open or version restore', async () => {
    const remote = successfulRemote()
    const open = vi.spyOn(remote, 'open')
    const restore = vi.spyOn(remote, 'restore')
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    controller.updateDraft(SESSION_ID, 'Unsaved introduction')

    await controller.openDocument(
      WORKSPACE_ID,
      SESSION_ID,
      'another-resource' as typeof RESOURCE_ID,
    )
    expect(open).toHaveBeenCalledOnce()
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      dirty: true, draft: 'Unsaved introduction', document: { documentId: DOCUMENT_ID },
    })

    await expect(controller.restore(SESSION_ID, COMMIT_0)).resolves.toEqual({
      ok: false,
      error: 'commit or discard the selected node draft before restoring a version',
    })
    expect(restore).not.toHaveBeenCalled()
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().dirty).toBe(true)
    controller.dispose()
  })

  it('auto-refreshes a clean document after a durable external commit', async () => {
    const remote = successfulRemote()
    const open = vi.fn<PaperAIWorkbenchRemote['open']>()
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult() })
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_2) })
    remote.open = open
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)

    controller.handleDocumentChanged({
      documentId: DOCUMENT_ID,
      headCommitId: COMMIT_2,
      updatedAt: '2026-08-28T12:00:00.000Z',
    })
    await vi.waitFor(() => {
      expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
        action: null,
        externalUpdate: null,
        document: { revision: REVISION_2, headCommitId: COMMIT_2 },
      })
    })
    expect(open).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('rebases a dirty draft when its selected node did not change externally', async () => {
    const remote = successfulRemote()
    const open = vi.fn<PaperAIWorkbenchRemote['open']>()
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult() })
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_2) })
    remote.open = open
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    controller.updateDraft(SESSION_ID, 'Unsaved local draft')
    const change = {
      documentId: DOCUMENT_ID,
      headCommitId: COMMIT_2,
      updatedAt: '2026-08-28T12:00:00.000Z',
    } as const

    controller.handleDocumentChanged(change)
    expect(open).toHaveBeenCalledOnce()
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      dirty: true,
      draft: 'Unsaved local draft',
      externalUpdate: change,
      document: { headCommitId: COMMIT_1 },
    })

    await expect(controller.reloadExternal(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      dirty: true,
      draft: 'Unsaved local draft',
      externalUpdate: null,
      document: { revision: REVISION_2, headCommitId: COMMIT_2 },
      selectedNode: { baseRevision: REVISION_2, baseCommitId: COMMIT_2 },
    })
    expect(open).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('consumes the pending external event when the authoritative reload has already advanced further', async () => {
    const remote = successfulRemote()
    remote.open = vi.fn<PaperAIWorkbenchRemote['open']>()
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult() })
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_3) })
    remote.readNode = vi.fn<PaperAIWorkbenchRemote['readNode']>(async () => ({
      ok: true,
      value: textNodeBuffer(REVISION_3, 'Authoritative R3 rewrite'),
    }))
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    controller.updateDraft(SESSION_ID, 'Unsaved local draft')
    controller.handleDocumentChanged({
      documentId: DOCUMENT_ID,
      headCommitId: COMMIT_2,
      updatedAt: '2026-08-28T12:00:00.000Z',
    })

    await expect(controller.reloadExternal(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      document: { revision: REVISION_3, headCommitId: COMMIT_3 },
      externalUpdate: null,
      externalConflict: {
        localDraft: 'Unsaved local draft',
        externalText: 'Authoritative R3 rewrite',
      },
    })
    expect(remote.readNode).toHaveBeenCalledWith(expect.objectContaining({
      revision: REVISION_3,
      headCommitId: COMMIT_3,
    }), expect.any(AbortSignal))
    controller.dispose()
  })

  it('preserves a newer external event that arrives while the pending event reload is in flight', async () => {
    const pendingOpen = deferred<RemoteResult<PaperAIDocumentOpenResult>>()
    const remote = successfulRemote()
    remote.open = vi.fn<PaperAIWorkbenchRemote['open']>()
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult() })
      .mockImplementationOnce(() => pendingOpen.promise)
    remote.readNode = vi.fn<PaperAIWorkbenchRemote['readNode']>(async () => ({
      ok: true,
      value: textNodeBuffer(REVISION_3, 'Authoritative R3 rewrite'),
    }))
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    controller.updateDraft(SESSION_ID, 'Unsaved local draft')
    controller.handleDocumentChanged({
      documentId: DOCUMENT_ID,
      headCommitId: COMMIT_2,
      updatedAt: '2026-08-28T12:00:00.000Z',
    })

    const reload = controller.reloadExternal(SESSION_ID)
    await vi.waitFor(() => { expect(remote.open).toHaveBeenCalledTimes(2) })
    const newestChange = {
      documentId: DOCUMENT_ID,
      headCommitId: COMMIT_4,
      updatedAt: '2026-08-28T12:02:00.000Z',
    } as const
    controller.handleDocumentChanged(newestChange)
    pendingOpen.resolve({ ok: true, value: documentOpenResult(REVISION_3) })

    await expect(reload).resolves.toEqual({ ok: true })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      document: { revision: REVISION_3, headCommitId: COMMIT_3 },
      externalUpdate: newestChange,
      externalConflict: {
        localDraft: 'Unsaved local draft',
        externalText: 'Authoritative R3 rewrite',
      },
    })
    controller.dispose()
  })

  it('rebases a same-node conflict onto the external head and commits the chosen local draft', async () => {
    const remote = successfulRemote()
    remote.open = vi.fn<PaperAIWorkbenchRemote['open']>()
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult() })
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_2) })
    remote.readNode = vi.fn<PaperAIWorkbenchRemote['readNode']>(async () => ({
      ok: true,
      value: textNodeBuffer(REVISION_2, 'External rewrite'),
    }))
    const commit = vi.spyOn(remote, 'commit')
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    controller.updateDraft(SESSION_ID, 'Unsaved local draft')
    const change = {
      documentId: DOCUMENT_ID,
      headCommitId: COMMIT_2,
      updatedAt: '2026-08-28T12:00:00.000Z',
    } as const
    controller.handleDocumentChanged(change)

    await expect(controller.reloadExternal(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      action: null,
      dirty: true,
      draft: 'Unsaved local draft',
      externalUpdate: null,
      externalConflict: {
        localDraft: 'Unsaved local draft',
        externalText: 'External rewrite',
      },
      document: { revision: REVISION_2, headCommitId: COMMIT_2 },
      selectedNode: {
        baseRevision: REVISION_2,
        baseCommitId: COMMIT_2,
        text: 'External rewrite',
      },
    })

    controller.resolveExternalConflict(SESSION_ID, 'local')
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      externalConflict: null,
      dirty: true,
      draft: 'Unsaved local draft',
    })
    await expect(controller.commitSelected(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      baseRevision: REVISION_2,
      baseCommitId: COMMIT_2,
      mutations: [{
        type: 'replace-text',
        nodeId: NODE_HEADING,
        baseText: 'External rewrite',
        nextText: 'Unsaved local draft',
      }],
    }), expect.any(AbortSignal))
    controller.dispose()
  })

  it('adopts the external text or resolves an edited merge without losing either conflict input', async () => {
    for (const resolution of ['external', 'merged'] as const) {
      const remote = successfulRemote()
      remote.open = vi.fn<PaperAIWorkbenchRemote['open']>()
        .mockResolvedValueOnce({ ok: true, value: documentOpenResult() })
        .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_2) })
      remote.readNode = vi.fn<PaperAIWorkbenchRemote['readNode']>(async () => ({
        ok: true,
        value: textNodeBuffer(REVISION_2, 'External rewrite'),
      }))
      const commit = vi.spyOn(remote, 'commit')
      const controller = new PaperAIWorkbenchController(remote)
      await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
      controller.updateDraft(SESSION_ID, 'Unsaved local draft')
      controller.handleDocumentChanged({
        documentId: DOCUMENT_ID,
        headCommitId: COMMIT_2,
        updatedAt: '2026-08-28T12:00:00.000Z',
      })
      await controller.reloadExternal(SESSION_ID)

      if (resolution === 'merged') controller.updateDraft(SESSION_ID, 'Merged local and external text')
      controller.resolveExternalConflict(SESSION_ID, resolution)
      const resolved = controller.workbenchStore(SESSION_ID).getSnapshot()
      expect(resolved.externalConflict).toBeNull()
      expect(resolved.draft).toBe(resolution === 'external'
        ? 'External rewrite'
        : 'Merged local and external text')
      expect(resolved.dirty).toBe(resolution === 'merged')
      if (resolution === 'merged') {
        await expect(controller.commitSelected(SESSION_ID)).resolves.toEqual({ ok: true })
        expect(commit).toHaveBeenCalledWith(expect.objectContaining({
          baseRevision: REVISION_2,
          baseCommitId: COMMIT_2,
          mutations: [expect.objectContaining({
            baseText: 'External rewrite',
            nextText: 'Merged local and external text',
          })],
        }), expect.any(AbortSignal))
      }
      controller.dispose()
    }
  })

  it('retains the edited merge when a second external head arrives and commits from the newest base', async () => {
    const remote = successfulRemote()
    remote.open = vi.fn<PaperAIWorkbenchRemote['open']>()
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult() })
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_2) })
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_3) })
    remote.readNode = vi.fn<PaperAIWorkbenchRemote['readNode']>(async request => ({
      ok: true,
      value: textNodeBuffer(
        request.revision,
        request.revision === REVISION_2 ? 'First external rewrite' : 'Second external rewrite',
      ),
    }))
    const commit = vi.spyOn(remote, 'commit')
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    controller.updateDraft(SESSION_ID, 'Unsaved local draft')
    controller.handleDocumentChanged({
      documentId: DOCUMENT_ID,
      headCommitId: COMMIT_2,
      updatedAt: '2026-08-28T12:00:00.000Z',
    })
    await controller.reloadExternal(SESSION_ID)
    controller.updateDraft(SESSION_ID, 'Merge in progress')

    const nextChange = {
      documentId: DOCUMENT_ID,
      headCommitId: COMMIT_3,
      updatedAt: '2026-08-28T12:01:00.000Z',
    } as const
    controller.handleDocumentChanged(nextChange)
    expect(remote.open).toHaveBeenCalledTimes(2)
    await controller.reloadExternal(SESSION_ID)
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      document: { revision: REVISION_3, headCommitId: COMMIT_3 },
      draft: 'Merge in progress',
      externalConflict: {
        localDraft: 'Merge in progress',
        externalText: 'Second external rewrite',
      },
    })

    controller.updateDraft(SESSION_ID, 'Final merged text')
    controller.resolveExternalConflict(SESSION_ID, 'merged')
    await expect(controller.commitSelected(SESSION_ID)).resolves.toEqual({ ok: true })
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      baseRevision: REVISION_3,
      baseCommitId: COMMIT_3,
      mutations: [expect.objectContaining({
        baseText: 'Second external rewrite',
        nextText: 'Final merged text',
      })],
    }), expect.any(AbortSignal))
    controller.dispose()
  })

  it('retains an unresolved conflict when a newer head changes only another node', async () => {
    const remote = successfulRemote()
    remote.open = vi.fn<PaperAIWorkbenchRemote['open']>()
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult() })
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_2) })
      .mockResolvedValueOnce({ ok: true, value: documentOpenResult(REVISION_3) })
    remote.readNode = vi.fn<PaperAIWorkbenchRemote['readNode']>(async request => ({
      ok: true,
      value: textNodeBuffer(request.revision, 'External rewrite'),
    }))
    const commit = vi.spyOn(remote, 'commit')
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    controller.updateDraft(SESSION_ID, 'Unsaved local draft')
    controller.handleDocumentChanged({
      documentId: DOCUMENT_ID,
      headCommitId: COMMIT_2,
      updatedAt: '2026-08-28T12:00:00.000Z',
    })
    await controller.reloadExternal(SESSION_ID)
    controller.updateDraft(SESSION_ID, 'Merge in progress')

    controller.handleDocumentChanged({
      documentId: DOCUMENT_ID,
      headCommitId: COMMIT_3,
      updatedAt: '2026-08-28T12:01:00.000Z',
    })
    await controller.reloadExternal(SESSION_ID)

    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      document: { revision: REVISION_3, headCommitId: COMMIT_3 },
      selectedNode: {
        baseRevision: REVISION_3,
        baseCommitId: COMMIT_3,
        text: 'External rewrite',
      },
      draft: 'Merge in progress',
      dirty: true,
      externalUpdate: null,
      externalConflict: {
        localDraft: 'Unsaved local draft',
        externalText: 'External rewrite',
      },
    })
    await expect(controller.commitSelected(SESSION_ID)).resolves.toEqual({
      ok: false,
      error: 'resolve the external node conflict before committing',
    })
    expect(commit).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('rejects a commit projection that switches document identity', async () => {
    const remote = successfulRemote()
    remote.commit = vi.fn<PaperAIWorkbenchRemote['commit']>(async () => {
      const opened = documentOpenResult(REVISION_2)
      return {
        ok: true,
        value: {
          ...opened,
          document: { ...opened.document, documentId: 'other-document' as typeof DOCUMENT_ID },
          createdCommitId: COMMIT_2,
        },
      }
    })
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    controller.updateDraft(SESSION_ID, 'Rewritten introduction')

    await expect(controller.commitSelected(SESSION_ID)).resolves.toEqual({
      ok: false, error: 'paperaiWorkbench returned an invalid commit projection',
    })
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      dirty: true,
      action: null,
      document: { documentId: DOCUMENT_ID },
    })
    controller.dispose()
  })

  it('folds a rejected Remote call into a retryable error state', async () => {
    const remote = successfulRemote()
    remote.open = vi.fn<PaperAIWorkbenchRemote['open']>().mockRejectedValue(new Error('namespace unloaded'))
    const controller = new PaperAIWorkbenchController(remote)

    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    expect(controller.workbenchStore(SESSION_ID).getSnapshot()).toMatchObject({
      phase: 'error', error: 'remote-rejected: namespace unloaded',
    })

    remote.open = vi.fn<PaperAIWorkbenchRemote['open']>()
      .mockResolvedValue({ ok: true, value: documentOpenResult() })
    await controller.retryOpen(SESSION_ID)
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().phase).toBe('ready')
    controller.dispose()
  })

  it('aborts active reads and rejects callbacks after disposal', async () => {
    const pending = deferred<RemoteResult<PaperAIResourceList>>()
    let signal: AbortSignal | undefined
    const remote = successfulRemote()
    remote.list = vi.fn<PaperAIWorkbenchRemote['list']>((_request, nextSignal) => {
      signal = nextSignal
      return pending.promise
    })
    const controller = new PaperAIWorkbenchController(remote)
    const load = controller.loadResources(WORKSPACE_ID)

    controller.dispose()
    expect(signal?.aborted).toBe(true)
    pending.resolve({ ok: true, value: RESOURCES })
    await load
    expect(() => controller.resourceStore(WORKSPACE_ID)).toThrow('controller disposed')
  })
})
