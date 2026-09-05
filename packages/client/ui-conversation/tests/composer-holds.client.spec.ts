import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'

describe('composer transition holds', () => {
  it('keeps drafts editable during replacement and restores the latest model prerequisite afterwards', () => {
    const registry = new ComposerBlockRegistry()
    const id = 'session' as SessionId
    const source = registry.storeFor(id)
    registry.set(id, { reason: 'Choose model' })
    const block = { reason: 'Connecting', allowDraft: true }
    const release = registry.hold(id, block)
    const other = registry.hold(id, block)
    registry.set(id, { reason: 'Model unavailable' })
    release()
    release()
    expect(source.getSnapshot()).toEqual(block)
    other()
    expect(source.getSnapshot()).toEqual({ reason: 'Model unavailable' })
  })

  it('does not publish an old hold into a newly created session scope', () => {
    const registry = new ComposerBlockRegistry()
    const id = 'session' as SessionId
    const release = registry.hold(id, { reason: 'Connecting', allowDraft: true })
    registry.forget(id)
    registry.set(id, { reason: 'New scope' })
    release()
    expect(registry.storeFor(id).getSnapshot()).toEqual({ reason: 'New scope' })
  })
})
