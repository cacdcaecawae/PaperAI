// @vitest-environment jsdom
/** Real Session paging through the registered Trajectory entry and both mounted consumers. */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { HistoryEntry, IApiClient, RpcId, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import {
  ConversationEventRegistry, ConversationViewRegistry, SlotRegistry,
} from '@deepseek-ai/dsh-client-runtime/client'
import { Session } from '@deepseek-ai/dsh-client-runtime/src/client/sessions/session.ts'
import { bindSnapshotSelector, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as localeApply, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { TrajectoryView, type TrajectoryViewInjected } from '../src/client/TrajectoryView.tsx'

const SID = 'trajectory-paging-reconnect' as SessionId
type HistoryReply = Awaited<ReturnType<IApiClient['sessions']['history']>>
type Consumer = 'table' | 'timeline'
// StoredEntry erases inject callbacks; the selected registration's mapped
// result retains its declared members and satisfies the stored record type.
type TrajectoryInjection = (sessionId: SessionId) => {
  [Key in keyof TrajectoryViewInjected]: TrajectoryViewInjected[Key]
}

function page(seq: number, text: string, hasMore: boolean): HistoryReply {
  const events: HistoryEntry[] = [{
    event: {
      type: 'user/message', seq, time: 1_700_000_000_000 + seq,
      surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    },
  }]
  return { rpcId: `history-${seq}` as RpcId, result: { ok: true, value: { events, hasMore } } }
}

async function bench(history: IApiClient['sessions']['history']) {
  const ctx = new Context()
  onTestFinished(async () => {
    cleanup()
    await ctx.fiber.dispose()
  })
  const slots = new SlotRegistry(ctx)
  await ctx.plugin(ConversationEventRegistry).await()
  await ctx.plugin(ConversationViewRegistry).await()
  ctx.provide('sessions', { binding: () => ({ session }) })
  slots.register({
    name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' } },
  }, (_props: { renderSlot?: unknown }) => null)
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  ctx.plugin({ inject: [...localeInject], apply: localeApply })
  await ctx.plugin({ inject: [...inject], apply }).await()
  ctx.locale.setLocale('en')
  // History is the only programmed Session operation; event and view
  // assembly remain real.
  const api = { sessions: { history } } as unknown as IApiClient
  const session = new Session(SID, api, {
    commands: {
      list: () => Promise.resolve({ ok: true, value: [] }),
      execute: () => Promise.resolve({ ok: true, value: undefined }),
    },
  }, { conversation: { events: ctx.conversationEvents, views: ctx.conversationViews } })
  onTestFinished(() => { session.dispose() })
  await session.open()
  const entry = slots.entries('conversation.view').find(candidate => candidate.options.id === 'trajectory')
  if (entry?.inject === undefined) throw new Error('Trajectory injection was not registered')
  expect(entry.component).toBe(TrajectoryView)
  const injectEntry = entry.inject as TrajectoryInjection
  const injected = injectEntry(SID)
  const loadOlder = vi.spyOn(session, 'loadOlder')
  const mountedSession = session
  const useSession = bindSnapshotSelector({
    getSnapshot: () => mountedSession.getSnapshot(),
    subscribe: listener => mountedSession.subscribe(listener),
  })
  render(<TrajectoryView
    {...({ sessionId: SID, useSession } as ConvViewProps)}
    loadOlder={injected.loadOlder}
    setActualDuration={injected.setActualDuration}
    useDuration={bindSnapshotSelector(injected.hooks.duration)}
    t={ctx.locale.bind('trajectory')}
  />)
  return { session, loadOlder }
}

function control(consumer: Consumer): HTMLButtonElement {
  const root = consumer === 'table'
    ? screen.getByRole('table')
    : screen.getByRole('region', { name: 'Trajectory timeline' })
  const button = root.querySelector<HTMLButtonElement>(consumer === 'table'
    ? '[data-history-load] button'
    : '[data-earlier-history]')
  if (button === null) throw new Error(`${consumer} earlier-history control is missing`)
  return button
}

function busy(button: HTMLButtonElement): boolean {
  return button.disabled || button.getAttribute('aria-disabled') === 'true'
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

describe('Trajectory paging after reconnect', () => {
  it.each<Consumer>(['table', 'timeline'])(
    'releases the mounted %s lock before stale transport settles and preserves the fresh lock',
    async (consumer) => {
      localStorage.clear()
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
      const stale = Promise.withResolvers<HistoryReply>()
      const fresh = Promise.withResolvers<HistoryReply>()
      let staleSettled = false
      let freshSettled = false
      void stale.promise.then(() => { staleSettled = true })
      void fresh.promise.then(() => { freshSettled = true })
      const history = vi.fn<IApiClient['sessions']['history']>()
        .mockResolvedValueOnce(page(10, 'tail', true))
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValueOnce(page(10, 'tail after reconnect', true))
        .mockReturnValueOnce(fresh.promise)
      const b = await bench(history)
      try {
        const table = screen.getByRole('table')
        const timeline = screen.getByRole('region', { name: 'Trajectory timeline' })
        expect(timeline.querySelector('[data-timeline-domain]')).not.toBeNull()
        expect(timeline.querySelectorAll('[data-timeline-span="user"]').length).toBe(1)
        fireEvent.click(control(consumer))
        await waitFor(() => { expect(busy(control(consumer))).toBe(true) })
        expect(b.loadOlder).toHaveBeenCalledTimes(1)
        expect(history).toHaveBeenCalledTimes(2)

        await act(async () => { await b.session.resync() })
        await waitFor(() => { expect(busy(control(consumer))).toBe(false) })
        expect(screen.getByRole('table')).toBe(table)
        expect(screen.getByRole('region', { name: 'Trajectory timeline' })).toBe(timeline)
        expect(staleSettled).toBe(false)
        expect(b.session.getSnapshot().hasMore).toBe(true)

        fireEvent.click(control(consumer))
        await waitFor(() => { expect(history).toHaveBeenCalledTimes(4) })
        expect(b.loadOlder).toHaveBeenCalledTimes(2)
        expect(history.mock.calls[3]?.[0]).toMatchObject({ sessionId: SID, beforeSeq: 10 })
        expect(busy(control(consumer))).toBe(true)
        expect(staleSettled).toBe(false)

        await act(async () => {
          stale.resolve(page(9, 'obsolete older row', false))
          await stale.promise
        })
        expect(staleSettled).toBe(true)
        expect(freshSettled).toBe(false)
        expect(b.session.getSnapshot().loadingOlder).toBe(true)
        expect(b.session.getSnapshot().hasMore).toBe(true)
        expect(busy(control(consumer))).toBe(true)
        fireEvent.click(control(consumer))
        expect(b.loadOlder).toHaveBeenCalledTimes(2)
        expect(history).toHaveBeenCalledTimes(4)
        expect(screen.queryByText('obsolete older row')).toBeNull()

        await act(async () => {
          fresh.resolve(page(9, 'fresh older row', false))
          await fresh.promise
        })
        await waitFor(() => { expect(screen.getByText('fresh older row')).toBeTruthy() })
        expect(b.session.getSnapshot().loadingOlder).toBe(false)
        expect(b.session.getSnapshot().hasMore).toBe(false)
        expect(document.querySelector('[data-history-load]')).toBeNull()
        expect(document.querySelector('[data-earlier-history]')).toBeNull()
        expect(screen.queryByText('obsolete older row')).toBeNull()
      } finally {
        await act(async () => {
          stale.resolve(page(9, 'obsolete older row', false))
          fresh.resolve(page(9, 'fresh older row', false))
          await Promise.all([stale.promise, fresh.promise])
        })
      }
    },
  )
})
