import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  ConversationDetailsController, TOOL_DETAILS_VIEW_ID,
} from '../src/client/details-controller.ts'

const sid = (value: string): SessionId => value as SessionId

function bench() {
  let current: SessionId | undefined = sid('a')
  const views = new Set(['paperai'])
  const openPanel = vi.fn()
  const closePanel = vi.fn()
  const controller = new ConversationDetailsController({
    currentSession: () => current,
    hasView: id => views.has(id),
    openPanel,
    closePanel,
  })
  return { controller, views, openPanel, closePanel, setCurrent: (id?: SessionId) => { current = id } }
}

describe('ConversationDetailsController', () => {
  it('keeps one selected view per Session and opens through the layout callback', () => {
    const b = bench()
    const a = b.controller.source(sid('a'))
    const other = b.controller.source(sid('b'))
    b.controller.open('paperai')
    expect(a.getSnapshot()).toBe('paperai')
    expect(other.getSnapshot()).toBe(TOOL_DETAILS_VIEW_ID)
    expect(b.openPanel).toHaveBeenCalledTimes(1)

    b.controller.open(TOOL_DETAILS_VIEW_ID, sid('b'))
    expect(other.getSnapshot()).toBe(TOOL_DETAILS_VIEW_ID)
    expect(b.openPanel).toHaveBeenCalledTimes(2)
    b.controller.close()
    expect(b.closePanel).toHaveBeenCalledTimes(1)
  })

  it('rejects missing targets and unknown additive views', () => {
    const b = bench()
    b.setCurrent(undefined)
    expect(() => { b.controller.open('paperai') }).toThrow(/no current session/)
    expect(() => { b.controller.open('missing', sid('a')) }).toThrow(/unknown view/)
    expect(b.openPanel).not.toHaveBeenCalled()
  })

  it('falls back to Tool when an active additive view unloads', () => {
    const b = bench()
    const source = b.controller.source(sid('a'))
    const listener = vi.fn()
    source.subscribe(listener)
    b.controller.open('paperai', sid('a'))
    b.views.delete('paperai')
    b.controller.reconcile()
    expect(source.getSnapshot()).toBe(TOOL_DETAILS_VIEW_ID)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('rejects stale callbacks after disposal', () => {
    const b = bench()
    b.controller.dispose()
    expect(() => b.controller.source(sid('a'))).toThrow(/disposed/)
    expect(() => { b.controller.open(TOOL_DETAILS_VIEW_ID, sid('a')) }).toThrow(/disposed/)
    expect(() => { b.controller.close() }).toThrow(/disposed/)
  })
})
