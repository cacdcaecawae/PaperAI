import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { SessionBinding, SessionFace, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { DraftAttachmentId } from '../src/client/input/contract.ts'
import type { SessionInputShell } from '../src/client/input/facade.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'

async function bench() {
  const ctx = new Context()
  const scope = ctx.plugin(() => {})
  await scope
  const subscribers = new Set<() => void>()
  const sends: { text: string; signal: AbortSignal }[] = []
  const releases: DraftAttachmentId[] = []
  let finish!: (outcome: SubmitOutcome) => void
  const pending = new Promise<SubmitOutcome>((resolve) => { finish = resolve })
  const queued: { id: string; placement: 'queued' }[] = []
  const steers: string[] = []
  const snapshot = { queue: queued }
  // The hub consumes only the queue observable and passes the Session to its sink.
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      subscribers.add(fn)
      return () => { subscribers.delete(fn) }
    },
    updateQueue: (id: string) => {
      steers.push(id)
      return Promise.resolve({ ok: true, value: { accepted: true } })
    },
  } as unknown as SessionFace
  const binding: SessionBinding = {
    sessionId: 'retained' as SessionId,
    ctx: scope.ctx as SessionBinding['ctx'],
    session,
  }
  ctx.reflect.provide('conversation', {
    sendSession: (_session: SessionFace, text: string, _ids: readonly DraftAttachmentId[], _mode: string, signal: AbortSignal) => {
      sends.push({ text, signal })
      return pending
    },
    releaseDraftImage: (id: DraftAttachmentId) => { releases.push(id) },
  } as never)
  const mount = async () => {
    let hub!: InputHub
    const feature = ctx.plugin((pluginCtx) => { hub = new InputHub(pluginCtx, makeTranslate(zh)) })
    await feature
    return { feature, hub, shell: hub.shellFor(binding) }
  }
  const pick = (shell: SessionInputShell) => scope.ctx.bail(scope.ctx, 'slash/input-insert-reference', {
    reference: { source: 'reference', ref: 'doc-a', label: 'Research notes', clipboardText: '@Research notes' },
    span: { start: 0, end: shell.snapshot.draft.length, draftRev: shell.snapshot.draftRev },
  })
  return { scope, binding, subscribers, sends, releases, queued, steers, finish, mount, pick }
}

describe('input hub lifetime', () => {
  it('routes reference selections only to the current shell across repeated plugin replacement', async () => {
    const b = await bench()
    let old = await b.mount()
    for (let n = 0; n < 2; n += 1) {
      old.shell.setDraft('@res')
      expect(old.hub.shellFor(b.binding)).toBe(old.shell)
      expect(b.subscribers.size).toBe(1)
      await old.feature.dispose()
      expect(b.pick(old.shell)).toBeUndefined()
      expect(b.subscribers.size).toBe(0)
      const current = await b.mount()
      current.shell.setDraft('@res')
      expect(b.pick(current.shell)).toBe(true)
      expect(current.shell.snapshot.draft).toBe('@Research notes ')
      expect(old.shell.snapshot.draft).toBe('@res')
      old = current
    }
    await old.feature.dispose()
    await b.scope.dispose()
  })

  it.each(['scope-first', 'together'] as const)('releases both owners and images exactly once: %s', async (order) => {
    const b = await bench()
    const old = await b.mount()
    old.shell.addImages(['image-a' as DraftAttachmentId])
    if (order === 'scope-first') {
      await b.scope.dispose()
      expect(old.feature.getEffects()).toHaveLength(0)
      await old.feature.dispose()
    } else {
      await Promise.all([old.feature.dispose(), b.scope.dispose()])
    }
    expect(b.subscribers.size).toBe(0)
    expect(old.feature.getEffects()).toHaveLength(0)
    expect(b.scope.getEffects()).toHaveLength(0)
    expect(b.releases).toEqual(['image-a'])
  })

  it('cancels old admission and rejects captured callbacks after plugin disposal', async () => {
    const b = await bench()
    const old = await b.mount()
    const writes: string[] = []
    old.shell.bindMirror(text => writes.push(text))
    old.shell.setDraft('old pending')
    old.shell.submit()
    await old.feature.dispose()
    expect(b.sends).toHaveLength(1)
    expect(b.sends[0]!.signal.aborted).toBe(true)
    const current = await b.mount()
    current.shell.setDraft('newer draft')
    const checkpoint = writes.length
    expect(old.shell.addImages(['late-image' as DraftAttachmentId])).toBe(false)
    expect(old.shell.snapshot.imageIds).toEqual([])
    old.shell.bindMirror(text => writes.push(text))
    old.shell.actions.setDraft('obsolete edit')
    old.shell.actions.submit()
    b.queued.push({ id: 'q1', placement: 'queued' })
    old.shell.steerQueue()
    b.finish({ kind: 'success' })
    await Promise.resolve()
    expect(b.sends).toHaveLength(1)
    expect(b.steers).toEqual([])
    expect(writes).toHaveLength(checkpoint)
    expect(current.shell.snapshot.draft).toBe('newer draft')
    expect(old.shell.snapshot.draft).toBe('obsolete edit')
    expect(() => old.hub.shellFor(b.binding)).toThrow(/inactive context/)
    expect(b.subscribers.size).toBe(1)
    await current.feature.dispose()
    await b.scope.dispose()
  })
})
