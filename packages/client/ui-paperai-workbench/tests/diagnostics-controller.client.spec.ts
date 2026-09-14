/** Read-only inspection and guarded recovery remain independent of navigation. */
import { describe, expect, it, vi } from 'vitest'
import { DiagnosticsController } from '../src/client/diagnostics-controller.ts'
import { COMMIT_1, DOCUMENT_ID, successfulRemote, WORKSPACE_ID } from './fixtures.client.ts'

describe('diagnostic observations', () => {
  it('preserves findings across rejected scans and transport failures, then permits retry', async () => {
    const remote = successfulRemote()
    const controller = new DiagnosticsController(remote)
    await controller.inspect(WORKSPACE_ID)
    const report = controller.store.getSnapshot().projects[WORKSPACE_ID]!.report
    remote.inspectProject = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'scan refused', details: {} } })
      .mockRejectedValueOnce(new Error('disconnected'))
    await controller.inspect(WORKSPACE_ID)
    expect(controller.store.getSnapshot().projects[WORKSPACE_ID]).toMatchObject({ busy: false, report, error: 'scan refused' })
    await controller.inspect(WORKSPACE_ID)
    expect(controller.store.getSnapshot().projects[WORKSPACE_ID]).toMatchObject({ busy: false, report, error: 'Error: disconnected' })
    remote.inspectProject = successfulRemote().inspectProject
    await controller.inspect(WORKSPACE_ID)
    expect(controller.store.getSnapshot().projects[WORKSPACE_ID]!.error).toBeNull()
  })

  it('records a Working DOCX changed outside PaperAI through the same report path', async () => {
    const remote = successfulRemote()
    const capture = vi.spyOn(remote, 'captureExternal')
    const controller = new DiagnosticsController(remote)
    await controller.capture(WORKSPACE_ID, DOCUMENT_ID)
    expect(capture).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })
    expect(controller.store.getSnapshot().projects[WORKSPACE_ID]).toMatchObject({ busy: false, error: null })
    expect(controller.store.getSnapshot().projects[WORKSPACE_ID]?.report).not.toBeNull()
  })

  it('never repairs during a scan and rejects duplicate clicks while a repair is pending', async () => {
    const remote = successfulRemote()
    const scan = vi.spyOn(remote, 'inspectProject')
    const repair = vi.spyOn(remote, 'recoverWorking')
    const controller = new DiagnosticsController(remote)
    await controller.inspect(WORKSPACE_ID)
    expect(scan).toHaveBeenCalledOnce()
    expect(repair).not.toHaveBeenCalled()
    const plan = { documentId: DOCUMENT_ID, headCommitId: COMMIT_1, workingPath: '/project/working.docx', sha256: 'digest' }
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.recoverWorking>>>()
    repair.mockReturnValueOnce(pending.promise)
    const first = controller.inspect(WORKSPACE_ID, plan)
    await controller.inspect(WORKSPACE_ID, plan)
    expect(repair).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE_ID, plan })
    controller.dispose()
    const snapshot = controller.store.getSnapshot()
    pending.resolve({ ok: false, error: { code: 'internal', message: 'late reply', details: {} } })
    await first
    expect(controller.store.getSnapshot()).toBe(snapshot)
  })
})
