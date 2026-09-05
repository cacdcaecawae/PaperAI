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

  it('clears probe activity after protocol and transport failures and ignores failures after disposal', async () => {
    const remote = successfulRemote()
    const controller = new DiagnosticsController(remote)
    remote.agentDiagnostics = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'read refused', details: {} } })
      .mockRejectedValueOnce(new Error('read disconnected'))
    await controller.loadAgents()
    expect(controller.store.getSnapshot().agentError).toBe('read refused')
    await controller.loadAgents()
    expect(controller.store.getSnapshot().agentError).toBe('Error: read disconnected')
    remote.probeAgent = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'probe refused', details: {} } })
      .mockRejectedValueOnce(new Error('probe disconnected'))
    await controller.probe('codex', true)
    expect(controller.store.getSnapshot()).toMatchObject({ agentError: 'probe refused', probing: [] })
    await controller.probe('codex', true)
    expect(controller.store.getSnapshot()).toMatchObject({ agentError: 'Error: probe disconnected', probing: [] })
    const delayed = Promise.withResolvers<Awaited<ReturnType<typeof remote.probeAgent>>>()
    remote.probeAgent = vi.fn(() => delayed.promise)
    const pending = controller.probe('claude', true)
    controller.dispose()
    const snapshot = controller.store.getSnapshot()
    delayed.reject(new Error('late transport failure'))
    await pending
    await controller.inspect(WORKSPACE_ID)
    expect(controller.store.getSnapshot()).toBe(snapshot)
  })

  it('deduplicates a provider probe and ignores stale roster reads', async () => {
    const remote = successfulRemote()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.probeAgent>>>()
    remote.probeAgent = vi.fn(() => pending.promise)
    const controller = new DiagnosticsController(remote)
    const first = controller.probe('codex', false)
    await controller.probe('codex', true)
    expect(remote.probeAgent).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().probing).toEqual(['codex'])
    const result = await successfulRemote().probeAgent({ provider: 'codex', force: false })
    pending.resolve(result)
    await first
    expect(controller.store.getSnapshot().probing).toEqual([])
    const read = Promise.withResolvers<Awaited<ReturnType<typeof remote.agentDiagnostics>>>()
    remote.agentDiagnostics = vi.fn().mockImplementationOnce(() => read.promise).mockResolvedValueOnce({ ok: true, value: [] })
    const old = controller.loadAgents()
    await controller.loadAgents()
    read.resolve({ ok: false, error: { code: 'internal', message: 'stale', details: {} } })
    await old
    expect(controller.store.getSnapshot().agentError).toBeNull()
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
