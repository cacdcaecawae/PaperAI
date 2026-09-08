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
