/** Pending Agent intent stays responsive while the Host serializes replacement. */
import { describe, expect, it, vi } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentPresetSeatController, type SeatSessionSummary } from '../src/client/seat-store.ts'

function bench() {
  let current: SeatSessionSummary = { id: 'first' as SessionId, blank: true, agentPreset: 'codex' }
  const requests: Array<{ preset: string; finish: (accepted: boolean) => void }> = []
  const select = vi.fn(({ agentPreset }: { agentPreset: string }) => new Promise((resolve) => {
    requests.push({ preset: agentPreset, finish: (accepted) =>{  resolve({ rpcId: 'test', result: accepted
      ? { ok: true, value: { agentPreset } }
      : { ok: false, error: { message: 'Adapter failed' } } }) } })
  }))
  const release = vi.fn()
  const hold = vi.fn(() => release)
  const applied = vi.fn()
  const seat = new AgentPresetSeatController({ agentPresets: { select } } as unknown as IApiClient, () => current, applied, hold)
  return { seat, requests, select, hold, release, applied, move: () => { current = { id: 'second' as SessionId, blank: true, agentPreset: 'codex' } } }
}

describe('pending Agent selection', () => {
  it('aborts an in-flight replacement and keeps the current session bound until cancellation settles', async () => {
    const release = vi.fn()
    const select = vi.fn((_request: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('selection cancelled', { cause: signal.reason })) }, { once: true })
    }))
    const recovered = Promise.withResolvers<unknown>()
    const models = vi.fn(() => recovered.promise)
    const seat = new AgentPresetSeatController({ agentPresets: { select }, sessions: { models } } as unknown as IApiClient,
      () => ({ id: 'same' as SessionId, blank: true, agentPreset: 'codex' }), undefined, () => release)
    const selecting = seat.select('claude')
    expect(seat.store.getSnapshot()).toMatchObject({ current: 'claude', busy: true })
    seat.cancel()
    expect(select.mock.calls[0]![1].aborted).toBe(true)
    await vi.waitFor(() => { expect(models).toHaveBeenCalledOnce() })
    expect(release).not.toHaveBeenCalled()
    expect(seat.store.getSnapshot().busy).toBe(true)
    recovered.resolve({ result: { ok: true, value: {} } })
    await selecting
    expect(seat.store.getSnapshot()).toMatchObject({ current: 'codex', busy: false })
    expect(release).toHaveBeenCalledOnce()
    seat.dispose()
  })
  it('collapses intermediate picks to the latest intent and restores the last accepted route after failure', async () => {
    const b = bench()
    const first = b.seat.select('claude')
    const middle = b.seat.select('minimal')
    const last = b.seat.select('codex')
    expect(b.seat.store.getSnapshot()).toMatchObject({ current: 'codex', busy: true })
    expect(b.requests.map(request => request.preset)).toEqual(['claude'])
    b.requests[0]!.finish(true)
    await vi.waitFor(() => { expect(b.requests).toHaveLength(2) })
    expect(b.requests[1]!.preset).toBe('codex')
    b.requests[1]!.finish(false)
    await Promise.all([first, middle, last])
    expect(b.seat.store.getSnapshot()).toMatchObject({ current: 'claude', busy: false, error: 'Adapter failed' })
    expect(b.hold).toHaveBeenCalledTimes(2)
    expect(b.release).toHaveBeenCalledTimes(2)
  })

  it('never transfers a queued pick to another Workspace session', async () => {
    const b = bench()
    const first = b.seat.select('claude')
    const next = b.seat.select('minimal')
    b.move()
    b.requests[0]!.finish(true)
    await Promise.all([first, next])
    expect(b.select).toHaveBeenCalledTimes(1)
    expect(b.seat.store.getSnapshot()).toMatchObject({ current: 'codex', busy: false })
    expect(b.release).toHaveBeenCalledOnce()
  })

  it('releases the submission hold after disposal without publishing a late successful switch', async () => {
    const b = bench()
    const first = b.seat.select('claude')
    b.seat.dispose()
    b.requests[0]!.finish(true)
    await first
    expect(b.applied).not.toHaveBeenCalled()
    expect(b.release).toHaveBeenCalledOnce()
  })
})
