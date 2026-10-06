// @vitest-environment jsdom
// apply inject factories exercised end to end against the terminal thin
// API: the strict session API (views triple, draft mirror), the
// provide-channel input face (machine-sink submit choreography incl.
// transactional clear + failure retention), the resident API (selectWorkspace
// draft carrying), the composer-bar stop face, openDetails = select action +
// layout orchestration, and the closeDetails details API. Complements
// chat-apply.spec.tsx (registration) and selection-survival.spec.tsx (store
// axis). History opening is NOT an inject concern — the runtime sessions
// service opens on watch (sessions-service.spec.ts owns that behavior).
//
// The inject APIs are read off the ledger entries deliberately (typed at
// this spec's own contract): these cases pin factory choreography the UI
// guards would mask. Rendering-path acceptance lives in
// chat-toolview-slot.spec.tsx.

import { describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime, usePinnedBrowserLanguages, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionBehaviorOverrides } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ReferenceInsert } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ISession, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ChatViewInjected, ComposerBarInjected, ConversationInjected, ConversationSessionHeaderInjected,
  ConversationSessionInjected, DetailsHostInjected,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createChatStore } from '../src/client/stores.ts'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

const ROOT = 'root-1' as SessionId
const SESSION_REFERENCE = {
  source: 'reference', ref: '@[Research notes](dsh-session:InNvdXJjZSI)', label: 'Research notes',
  appearance: 'session', clipboardText: '@[Research notes](dsh-session:InNvdXJjZSI)',
} satisfies ReferenceInsert
const FILE_REFERENCE = {
  source: 'reference', ref: '@src/reference.txt', label: 'reference.txt',
  appearance: 'file', clipboardText: '@src/reference.txt',
} satisfies ReferenceInsert
const QUOTED_REFERENCE = {
  source: 'reference', ref: '@"docs/Research notes.md"', label: 'Research notes.md',
  appearance: 'file', clipboardText: '@"docs/Research notes.md"',
} satisfies ReferenceInsert

type ChatInstance = ReturnType<ReturnType<typeof createChatStore>['create']>
type ChatActions = ChatInstance['actions']

/** ISession verb mocks, typed against the production face (['prompt'] etc. keep vitest mock ergonomics). */
function sessionFakeFor() {
  return {
    open: vi.fn(() => Promise.resolve()),
    loadOlder: vi.fn<ISession['loadOlder']>(() => Promise.resolve()),
    prompt: vi.fn<ISession['prompt']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
    cancel: vi.fn<ISession['cancel']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
  } satisfies SessionBehaviorOverrides
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
  // The plugin injects both; these specs exercise no settings path.
  runtime.provide('remote', { $on: () => () => {} })
  runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const sessionFake = sessionFakeFor()
  await runtime.sessions.add({
    id: ROOT,
    summary: { title: 'R', displayTitle: 'R', cwd: '/proj' },
    session: sessionFake,
  })
  const layoutFake = { openDetails: vi.fn(), closeDetails: vi.fn() }
  runtime.provide('layout', layoutFake)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)

  // The AppFrame role: the conversation-package slots must be declared by a
  // live entry before apply can contribute into them.
  await runtime.root.declare({
    'conversation': { kind: 'single', scope: 'session-maybe' },
    'details': { kind: 'single', scope: 'session' },
  }, (_p: { renderSlot?: unknown }) => null)

  const feature = await runtime.mount({ inject: [...inject], apply })

  // The host face (store resolution) exists only inside the installed
  // renderer, so materialize it the way the shell does.
  runtime.renderRoot()
  const entryOf = (key: 'conversation' | 'conversation.session' | 'conversation.session.header' | 'conversation.composer.bar' | 'conversation.view' | 'details') =>
    runtime.slots.entries(key)[0]!
  /** Resolve store instance + call the inject the way the outlet would. */
  const conversationApi = (id: SessionId) => {
    const entry = entryOf('conversation.session')
    const instance = runtime.storeOf('conversation.session', id) as ChatInstance
    const injected = (entry.inject as unknown as (sessionId: SessionId, actions: ChatActions) => ConversationSessionInjected)(
      id, instance.actions)
    return { instance, injected }
  }
  const conversationHeaderApi = (id: SessionId) => {
    const entry = entryOf('conversation.session.header')
    const instance = runtime.storeOf('conversation.session.header', id) as ChatInstance
    const injected = (entry.inject as unknown as (sessionId: SessionId, actions: ChatActions) => ConversationSessionHeaderInjected)(
      id, instance.actions)
    return { instance, injected }
  }
  const residentApi = (id: SessionId | undefined) => {
    const entry = entryOf('conversation')
    return (entry.inject as unknown as (sessionId: SessionId | undefined) => ConversationInjected)(id)
  }
  const composerApi = (id: SessionId | undefined) => {
    const entry = entryOf('conversation.composer.bar')
    return (entry.inject as unknown as (sessionId: SessionId | undefined) => ComposerBarInjected)(id)
  }
  /** Same resolution for the chat entry riding the view ring. */
  const chatViewApi = (id: SessionId) => {
    const entry = entryOf('conversation.view')
    const instance = runtime.storeOf('conversation.view', id) as ChatInstance
    const injected = (entry.inject as unknown as (sessionId: SessionId, actions: ChatActions) => ChatViewInjected)(
      id, instance.actions)
    return { instance, injected }
  }
  /** Materialize the input provide contribution the way the runtime does. */
  const inputApi = (id: SessionId) => {
    const info = runtime.sessions.provideInfo(id)!
    const state = info.hooks['input'] as {
      getSnapshot: () => { draft: string }
      subscribe: (fn: () => void) => () => void
    }
    const actions = info.props['inputActions'] as {
      setDraft: (text: string) => void
      submit: () => void
    }
    return { state, actions }
  }
  /** Apply a real scoped reference pick at the end of the current draft. */
  const appendReference = (id: SessionId, reference: ReferenceInsert) => {
    const input = composerApi(id).keyboard!
    const start = input.snapshot.draft.length
    input.setDraft(input.snapshot.draft + '@')
    const scope = runtime.sessions.scope(id)!
    expect(scope.bail(scope, 'slash/input-insert-reference', {
      reference, span: { start, end: start + 1, draftRev: input.snapshot.draftRev },
    })).toBe(true)
  }
  return {
    runtime, feature, slots: runtime.slots, entryOf,
    conversationApi, conversationHeaderApi, residentApi, composerApi, chatViewApi, inputApi,
    sessionFake, layoutFake, appendReference,
  }
}

describe('conversation slot inject API', () => {
  it('assembles the thin API side-effect-free', async () => {
    const b = await bench()
    const { injected } = b.conversationApi(ROOT)
    // Assembly has no session side effects: opening the event window belongs
    // to the runtime watch path, not the inject factory.
    expect(b.sessionFake.open).not.toHaveBeenCalled()
    expect(injected.views.list().map(v => v.id)).toEqual(['chat'])

    const chatView = b.chatViewApi(ROOT)
    chatView.injected.loadOlder()
    expect(b.sessionFake.loadOlder).toHaveBeenCalledTimes(1)
    chatView.injected.forkAt(17)
    await vi.waitFor(() => {
      expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [ROOT] })
    })
    expect(b.runtime.sessions.calls).toContainEqual({
      method: 'fork', args: [{ sessionId: ROOT, atSeq: 17, increaseTitle: true }],
    })
    await b.runtime.dispose()
  })

  it('the provide-channel input face submits through the machine sink: trim, transactional clear, failure retains the draft', async () => {
    const b = await bench()
    const { injected } = b.conversationApi(ROOT)
    const { state, actions } = b.inputApi(ROOT)
    // Whitespace-only: the machine treats it as empty — no prompt, draft kept.
    actions.setDraft('   ')
    actions.submit()
    expect(b.sessionFake.prompt).not.toHaveBeenCalled()
    expect(state.getSnapshot().draft).toBe('   ')
    // Success: the draft clears only after the sink settles.
    actions.setDraft('hello')
    actions.submit()
    await vi.waitFor(() => {
      expect(state.getSnapshot().draft).toBe('')
    })
    expect(b.sessionFake.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'queue', expect.any(AbortSignal))
    // Failure: the draft is retained through the round-trip.
    b.sessionFake.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'b', details: { reason: 'b' } } })
    actions.setDraft('retry me')
    actions.submit()
    await vi.waitFor(() => {
      expect(b.sessionFake.prompt).toHaveBeenCalledTimes(2)
    })
    await new Promise(r => setTimeout(r, 0))
    expect(state.getSnapshot().draft).toBe('retry me')
    // Failure landing after new typing: no clobber (the interleaved edit wins).
    b.sessionFake.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'b', details: { reason: 'b' } } })
    actions.submit()
    actions.setDraft('typed during flight')
    await new Promise(r => setTimeout(r, 0))
    expect(state.getSnapshot().draft).toBe('typed during flight')
    // The provide contribution is idempotent per session: one shell identity.
    expect(b.inputApi(ROOT).state).toBe(state)
    // The draft mirror rides the conversation inject face.
    const mirrored: string[] = []
    const unbind = injected.bindDraftMirror(text => mirrored.push(text))
    actions.setDraft('mirrored text')
    expect(mirrored).toEqual(['mirrored text'])
    unbind()
    // Stop failure is swallowed (promptError owns the display).
    b.sessionFake.cancel.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'x', details: {} } })
    b.composerApi(ROOT).stop!()
    await new Promise(r => setTimeout(r, 0))
    expect(b.sessionFake.cancel).toHaveBeenCalledTimes(1)
    await b.runtime.dispose()
  })

  it.each(['', 'with text'])('retains image bytes and preview when removal races pending admission (%j)', async (draft) => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pending-image')
    const revoked = vi.spyOn(URL, 'revokeObjectURL')
    try {
      let settle!: (result: Awaited<ReturnType<ISession['prompt']>>) => void
      b.sessionFake.prompt.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
      const composer = b.composerApi(ROOT)
      const file = new File([Uint8Array.of(1, 2, 3)], 'retained.png', { type: 'image/png' })
      expect(composer.addImages!([file])).toBeNull()
      const id = composer.keyboard!.snapshot.imageIds[0]!
      composer.keyboard!.setDraft(draft)
      composer.keyboard!.submit('queue')
      await vi.waitFor(() => { expect(b.sessionFake.prompt).toHaveBeenCalledOnce() })
      composer.removeImage!(id)
      expect(composer.keyboard!.snapshot.imageIds).toEqual([id])
      expect(composer.draftImages!([id])).toMatchObject([{ id, previewUrl: 'blob:pending-image', file }])
      expect(revoked).not.toHaveBeenCalled()
      settle({ ok: false, error: { code: 'agent-busy', message: 'busy', details: { reason: 'busy' } } })
      await vi.waitFor(() => { expect(composer.keyboard!.snapshot.phase).toBe('plain') })
      composer.keyboard!.submit('queue')
      await vi.waitFor(() => { expect(composer.keyboard!.snapshot.imageIds).toEqual([]) })
      expect(b.sessionFake.prompt).toHaveBeenCalledTimes(2)
      expect(b.sessionFake.prompt.mock.calls[1]?.[0]).toEqual(b.sessionFake.prompt.mock.calls[0]?.[0])
      expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:pending-image')
      expect(composer.draftImages!([id])).toEqual([])
    } finally {
      await b.runtime.dispose()
      created.mockRestore()
      revoked.mockRestore()
    }
  })

  it('inject fails loud when the session resolves no binding or the scope lacks the service', async () => {
    const b = await bench()
    const entry = b.entryOf('conversation.composer.bar')
    const injectFn = entry.inject as unknown as (sessionId: SessionId | undefined) => ComposerBarInjected
    // Unknown session: the keyboard face's binding resolution answers nothing.
    expect(() => { injectFn('ghost' as SessionId).stop!() }).toThrow(/resolved no binding/)
    // No session (session-maybe absent side): machine faces absent, static
    // hooks compartment still present so the render side's hook order holds.
    const absent = injectFn(undefined)
    expect(absent.keyboard).toBeUndefined()
    expect(absent.toggleCommandMenu).toBeUndefined()
    expect(absent.stop).toBeUndefined()
    expect(absent.hooks.notices.getSnapshot()).toBeNull()
    expect(absent.hooks.lexicon.getSnapshot().size).toBe(0)
    expect(absent.hooks.menuLauncher.getSnapshot()).toBeNull()
    // A scope whose service tree lost 'conversation' (the feature fiber
    // unloaded while a retained inject closure re-runs): fails loud too.
    const stop = injectFn(ROOT).stop!
    await b.feature.dispose()
    expect(() => { stop() }).toThrow(/unavailable through the session scope/)
    await b.runtime.dispose()
  })

  it('openDetails (chat view face) writes the selection through the store actions and opens the panel', async () => {
    const b = await bench()
    const { instance, injected } = b.chatViewApi(ROOT)
    injected.openDetails({ turnSeq: 2, callId: 'c1' })
    expect(instance.store.getSnapshot().selection).toEqual({ turnSeq: 2, callId: 'c1' })
    expect(b.layoutFake.openDetails).toHaveBeenCalledTimes(1)
    // The chat view shares the conversation entry's store instance: selection
    // writes land where the skeleton and details read.
    const conv = b.conversationApi(ROOT)
    expect(conv.instance).toBe(instance)
    await b.runtime.dispose()
  })

  it('openFile (chat view face) resolves against session cwd and calls workspaces.openPath', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(ROOT)
    await injected.openFile('src/a.ts')
    await vi.waitFor(() => {
      expect(b.runtime.workspaces.calls).toContainEqual({ method: 'openPath', args: ['/proj/src/a.ts'] })
    })
    await b.runtime.dispose()
  })

  it('openFile rejects when the Host cannot open the path', async () => {
    const b = await bench()
    b.runtime.workspaces.stub('openPath', () => Promise.reject(new Error('xdg-open is not available')))
    const { injected } = b.chatViewApi(ROOT)
    await expect(injected.openFile('src/a.ts')).rejects.toThrow('xdg-open is not available')
    await b.runtime.dispose()
  })

  it('routes workspace switching through the runtime owner, carrying the draft', async () => {
    const b = await bench()
    const resident = b.residentApi(ROOT)
    // Same-session connect (the picked workspace resolves to this session):
    // no draft movement, plain re-open.
    b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(ROOT))
    const { state, actions } = b.inputApi(ROOT)
    actions.setDraft('carry me')
    void resident.selectWorkspace('workspace-1' as never)
    await vi.waitFor(() => {
      expect(b.runtime.sessions.calls.filter(c => c.method === 'open')).toHaveLength(1)
    })
    expect(b.runtime.workspaces.calls).toContainEqual({ method: 'connectWorkspace', args: ['workspace-1'] })
    expect(state.getSnapshot().draft).toBe('carry me')
    // Cross-session connect: the draft MOVES — the old machine empties, the
    // new session's machine receives the text, then navigation lands there.
    const OTHER = 'other-1' as SessionId
    await b.runtime.sessions.add({ id: OTHER }, { current: false })
    b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
    void resident.selectWorkspace('workspace-2' as never)
    await vi.waitFor(() => {
      expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [OTHER] })
    })
    expect(state.getSnapshot().draft).toBe('')
    expect(b.inputApi(OTHER).state.getSnapshot().draft).toBe('carry me')
    await b.runtime.dispose()
  })

  it.each([SESSION_REFERENCE, FILE_REFERENCE, QUOTED_REFERENCE])('carries canonical reference text across workspace selection ($ref)', async (reference) => {
    const b = await bench()
    try {
      const OTHER = 'reference-target' as SessionId
      const targetSession = sessionFakeFor()
      await b.runtime.sessions.add({ id: OTHER, session: targetSession }, { current: false })
      b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
      b.appendReference(ROOT, reference)
      const source = b.composerApi(ROOT).keyboard!
      expect(source.snapshot.draft).toBe(`@${reference.label} `)
      await b.residentApi(ROOT).selectWorkspace('reference-workspace' as never)
      expect(source.snapshot).toMatchObject({ draft: '', occurrences: [] })
      const target = b.composerApi(OTHER).keyboard!
      expect(target.snapshot.draft).toBe(reference.clipboardText + ' ')
      target.submit('queue')
      await vi.waitFor(() => { expect(targetSession.prompt).toHaveBeenCalledOnce() })
      expect(targetSession.prompt).toHaveBeenCalledWith(
        [{ type: 'text', text: reference.clipboardText }], 'queue', expect.any(AbortSignal),
      )
      expect(b.sessionFake.prompt).not.toHaveBeenCalled()
    } finally { await b.runtime.dispose() }
  })

  it('preserves multiple reference identities and surrounding text during workspace transfer', async () => {
    const b = await bench()
    try {
      const OTHER = 'multiple-reference-target' as SessionId
      await b.runtime.sessions.add({ id: OTHER }, { current: false })
      b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
      const source = b.composerApi(ROOT).keyboard!
      source.setDraft('Compare ')
      b.appendReference(ROOT, SESSION_REFERENCE)
      source.setDraft(source.snapshot.draft + 'with ')
      b.appendReference(ROOT, FILE_REFERENCE)
      source.setDraft(source.snapshot.draft + 'please')
      expect(source.snapshot.occurrences).toHaveLength(2)
      await b.residentApi(ROOT).selectWorkspace('reference-workspace' as never)
      expect(b.composerApi(OTHER).keyboard!.snapshot.draft)
        .toBe(`Compare ${SESSION_REFERENCE.clipboardText} with ${FILE_REFERENCE.clipboardText} please`)
      expect(source.snapshot).toMatchObject({ draft: '', occurrences: [] })
    } finally { await b.runtime.dispose() }
  })

  it('transfers an edited reference as ordinary text without restoring its former identity', async () => {
    const b = await bench()
    try {
      const OTHER = 'edited-reference-target' as SessionId
      await b.runtime.sessions.add({ id: OTHER }, { current: false })
      b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
      b.appendReference(ROOT, FILE_REFERENCE)
      const source = b.composerApi(ROOT).keyboard!
      source.setDraft('@reference-edited.txt ')
      expect(source.snapshot.occurrences).toEqual([])
      await b.residentApi(ROOT).selectWorkspace('reference-workspace' as never)
      expect(b.composerApi(OTHER).keyboard!.snapshot.draft).toBe('@reference-edited.txt ')
    } finally { await b.runtime.dispose() }
  })

  it('keeps structured references on the source during pending admission', async () => {
    const b = await bench()
    try {
      const OTHER = 'pending-reference-target' as SessionId
      await b.runtime.sessions.add({ id: OTHER }, { current: false })
      b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
      b.runtime.provide('inputTriggers', {
        sessionOf: () => ({ serializeReference: (_source: string, ref: string) => Promise.resolve(ref), track: vi.fn() }),
      } as never)
      let settle!: (result: Awaited<ReturnType<ISession['prompt']>>) => void
      b.sessionFake.prompt.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
      b.appendReference(ROOT, SESSION_REFERENCE)
      const source = b.composerApi(ROOT).keyboard!
      source.submit('queue')
      await vi.waitFor(() => { expect(b.sessionFake.prompt).toHaveBeenCalledOnce() })
      await b.residentApi(ROOT).selectWorkspace('reference-workspace' as never)
      expect(source.snapshot.draft).toBe('@Research notes ')
      expect(source.snapshot.occurrences).toHaveLength(1)
      expect(b.composerApi(OTHER).keyboard!.snapshot.draft).toBe('')
      settle({ ok: false, error: { code: 'internal', message: 'retry source', details: {} } })
      await vi.waitFor(() => { expect(source.snapshot.phase).toBe('plain') })
      expect(source.snapshot.occurrences).toHaveLength(1)
    } finally { await b.runtime.dispose() }
  })

  it('retains transferred canonical references and image bytes after destination rejection and retry', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reference-transfer')
    const revoked = vi.spyOn(URL, 'revokeObjectURL')
    try {
      const OTHER = 'rejected-reference-target' as SessionId
      const targetSession = sessionFakeFor()
      targetSession.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'retry target', details: {} } })
      await b.runtime.sessions.add({ id: OTHER, session: targetSession }, { current: false })
      b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
      const source = b.composerApi(ROOT)
      b.appendReference(ROOT, SESSION_REFERENCE)
      expect(source.addImages!([new File([Uint8Array.of(1, 2, 3)], 'reference.png', { type: 'image/png' })])).toBeNull()
      const imageIds = source.keyboard!.snapshot.imageIds
      await b.residentApi(ROOT).selectWorkspace('reference-workspace' as never)
      expect(source.keyboard!.snapshot).toMatchObject({ draft: '', occurrences: [], imageIds: [] })
      const target = b.composerApi(OTHER)
      target.keyboard!.submit('queue')
      await vi.waitFor(() => { expect(target.keyboard!.snapshot.phase).toBe('plain') })
      expect(target.keyboard!.snapshot).toMatchObject({ draft: SESSION_REFERENCE.clipboardText + ' ', imageIds })
      expect(target.draftImages!(imageIds)).toHaveLength(1)
      expect(revoked).not.toHaveBeenCalled()
      target.keyboard!.submit('queue')
      await vi.waitFor(() => { expect(target.keyboard!.snapshot.draft).toBe('') })
      expect(targetSession.prompt).toHaveBeenCalledTimes(2)
      expect(targetSession.prompt.mock.calls[1]?.[0]).toEqual(targetSession.prompt.mock.calls[0]?.[0])
      expect(targetSession.prompt.mock.calls[0]?.[0].at(-1)).toEqual({ type: 'text', text: SESSION_REFERENCE.clipboardText })
      expect(target.keyboard!.snapshot.imageIds).toEqual([])
      expect(target.draftImages!(imageIds)).toEqual([])
    } finally {
      await b.runtime.dispose()
      created.mockRestore()
      revoked.mockRestore()
    }
  })

  it('moves an image-only draft without releasing the transferred attachment', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image-only-transfer')
    const revoked = vi.spyOn(URL, 'revokeObjectURL')
    try {
      const OTHER = 'image-only-target' as SessionId
      await b.runtime.sessions.add({ id: OTHER }, { current: false })
      b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
      const source = b.composerApi(ROOT)
      expect(source.addImages!([new File([Uint8Array.of(1)], 'only.png', { type: 'image/png' })])).toBeNull()
      const imageIds = source.keyboard!.snapshot.imageIds
      await b.residentApi(ROOT).selectWorkspace('reference-workspace' as never)
      expect(source.keyboard!.snapshot).toMatchObject({ draft: '', imageIds: [] })
      const target = b.composerApi(OTHER)
      expect(target.keyboard!.snapshot).toMatchObject({ draft: '', imageIds })
      expect(target.draftImages!(imageIds)).toHaveLength(1)
      expect(revoked).not.toHaveBeenCalled()
    } finally {
      await b.runtime.dispose()
      created.mockRestore()
      revoked.mockRestore()
    }
  })

  it.each([false, true])('replaces destination reference identities in one undoable edit (suffix=%s)', async (withSuffix) => {
    const b = await bench()
    try {
      const OTHER = 'occupied-reference-target' as SessionId
      const targetSession = sessionFakeFor()
      await b.runtime.sessions.add({ id: OTHER, session: targetSession }, { current: false })
      b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
      const source = b.composerApi(ROOT).keyboard!
      const target = b.composerApi(OTHER).keyboard!
      source.setDraft('Use ')
      target.setDraft('Use ')
      b.appendReference(ROOT, { ...FILE_REFERENCE, ref: '@reference.txt', clipboardText: '@reference.txt' })
      b.appendReference(OTHER, FILE_REFERENCE)
      if (withSuffix) {
        source.setDraft(source.snapshot.draft + 'fresh')
        target.setDraft(target.snapshot.draft + 'old')
      }
      const before = target.snapshot
      const transferred = 'Use @reference.txt ' + (withSuffix ? 'fresh' : '')
      await b.residentApi(ROOT).selectWorkspace('reference-workspace' as never)
      expect(source.snapshot).toMatchObject({ draft: '', occurrences: [] })
      expect(target.snapshot).toMatchObject({ draft: transferred, occurrences: [] })
      target.undo()
      expect(target.snapshot).toMatchObject({ draft: before.draft, occurrences: before.occurrences })
      target.redo()
      expect(target.snapshot).toMatchObject({ draft: transferred, occurrences: [] })
      target.submit('queue')
      await vi.waitFor(() => { expect(targetSession.prompt).toHaveBeenCalledOnce() })
      expect(targetSession.prompt).toHaveBeenCalledWith(
        [{ type: 'text', text: transferred.trim() }], 'queue', expect.any(AbortSignal),
      )
    } finally { await b.runtime.dispose() }
  })

  it('does not reinterpret incoming ordinary text as the destination old reference', async () => {
    const b = await bench()
    try {
      const OTHER = 'ordinary-reference-target' as SessionId
      const targetSession = sessionFakeFor()
      await b.runtime.sessions.add({ id: OTHER, session: targetSession }, { current: false })
      b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
      b.appendReference(OTHER, SESSION_REFERENCE)
      b.composerApi(ROOT).keyboard!.setDraft('@Research notes ')
      await b.residentApi(ROOT).selectWorkspace('reference-workspace' as never)
      const target = b.composerApi(OTHER).keyboard!
      expect(target.snapshot).toMatchObject({ draft: '@Research notes ', occurrences: [] })
      target.submit('queue')
      await vi.waitFor(() => { expect(targetSession.prompt).toHaveBeenCalledOnce() })
      expect(targetSession.prompt).toHaveBeenCalledWith(
        [{ type: 'text', text: '@Research notes' }], 'queue', expect.any(AbortSignal),
      )
    } finally { await b.runtime.dispose() }
  })

  it.each([true, false])('keeps a pending source admission on its session while workspace navigation completes (accepted=%s)', async (accepted) => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:workspace-transfer')
    const revoked = vi.spyOn(URL, 'revokeObjectURL')
    try {
      const OTHER = 'pending-target' as SessionId
      await b.runtime.sessions.add({ id: OTHER }, { current: false })
      let connect!: (id: SessionId) => void
      b.runtime.workspaces.stub('connectWorkspace', () => new Promise<SessionId>((resolve) => { connect = resolve }))
      let settle!: (result: Awaited<ReturnType<ISession['prompt']>>) => void
      b.sessionFake.prompt.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
      const source = b.composerApi(ROOT)
      const target = b.composerApi(OTHER)
      const file = new File([Uint8Array.of(1, 2, 3)], 'pending.png', { type: 'image/png' })
      expect(source.addImages!([file])).toBeNull()
      const imageId = source.keyboard!.snapshot.imageIds[0]!
      source.keyboard!.setDraft('pending source text')
      const switching = b.residentApi(ROOT).selectWorkspace('pending-workspace' as never)
      source.keyboard!.submit('queue')
      await vi.waitFor(() => { expect(b.sessionFake.prompt).toHaveBeenCalledOnce() })
      connect(OTHER)
      await switching
      expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [OTHER] })
      expect(target.keyboard!.snapshot).toMatchObject({ draft: '', imageIds: [] })
      expect(source.keyboard!.snapshot).toMatchObject({ draft: 'pending source text', imageIds: [imageId] })
      expect(revoked).not.toHaveBeenCalled()
      settle(accepted
        ? { ok: true, value: { accepted: true } }
        : { ok: false, error: { code: 'internal', message: 'retry source', details: {} } })
      await vi.waitFor(() => { expect(source.keyboard!.snapshot.phase).toBe('plain') })
      expect(source.keyboard!.snapshot.draft).toBe(accepted ? '' : 'pending source text')
      expect(source.keyboard!.snapshot.imageIds).toEqual(accepted ? [] : [imageId])
      expect(source.draftImages!([imageId])).toHaveLength(accepted ? 0 : 1)
      if (!accepted) {
        source.keyboard!.submit('queue')
        await vi.waitFor(() => { expect(source.keyboard!.snapshot.imageIds).toEqual([]) })
        expect(b.sessionFake.prompt.mock.calls[1]?.[0]).toEqual(b.sessionFake.prompt.mock.calls[0]?.[0])
      }
      expect(target.keyboard!.snapshot).toMatchObject({ draft: '', imageIds: [] })
    } finally {
      await b.runtime.dispose()
      created.mockRestore()
      revoked.mockRestore()
    }
  })

  it('retains the source draft while a slash command is being adjudicated during workspace selection', async () => {
    const b = await bench()
    try {
      const OTHER = 'adjudication-target' as SessionId
      await b.runtime.sessions.add({ id: OTHER }, { current: false })
      let adjudicate!: (outcome: 'handled') => void
      const pending = new Promise<'handled'>((resolve) => { adjudicate = resolve })
      b.runtime.provide('inputTriggers', { sessionOf: () => ({ adjudicate: () => pending, track: vi.fn() }) } as never)
      let connect!: (id: SessionId) => void
      b.runtime.workspaces.stub('connectWorkspace', () => new Promise<SessionId>((resolve) => { connect = resolve }))
      const source = b.composerApi(ROOT).keyboard!
      source.setDraft('/inspect')
      const switching = b.residentApi(ROOT).selectWorkspace('adjudication-workspace' as never)
      source.submit('queue')
      expect(source.snapshot.phase).toBe('adjudicating')
      connect(OTHER)
      await switching
      expect(source.snapshot.draft).toBe('/inspect')
      expect(b.composerApi(OTHER).keyboard!.snapshot.draft).toBe('')
      adjudicate('handled')
      await vi.waitFor(() => { expect(source.snapshot.phase).toBe('plain') })
      expect(b.sessionFake.prompt).not.toHaveBeenCalled()
    } finally {
      await b.runtime.dispose()
    }
  })

  it.each([false, true])('preserves both drafts when the selected destination has pending admission (image=%s)', async (withImage) => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:busy-target')
    try {
      const OTHER = 'busy-target' as SessionId
      const targetSession = sessionFakeFor()
      let settle!: (result: Awaited<ReturnType<ISession['prompt']>>) => void
      targetSession.prompt.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
      await b.runtime.sessions.add({ id: OTHER, session: targetSession }, { current: false })
      const source = b.composerApi(ROOT)
      const target = b.composerApi(OTHER)
      target.keyboard!.setDraft('target pending text')
      target.keyboard!.submit('queue')
      await vi.waitFor(() => { expect(targetSession.prompt).toHaveBeenCalledOnce() })
      source.keyboard!.setDraft('source unsent text')
      if (withImage) {
        expect(source.addImages!([new File([Uint8Array.of(1)], 'source.png', { type: 'image/png' })])).toBeNull()
      }
      const imageIds = source.keyboard!.snapshot.imageIds
      b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
      await b.residentApi(ROOT).selectWorkspace('busy-workspace' as never)
      expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [OTHER] })
      expect(source.keyboard!.snapshot).toMatchObject({ draft: 'source unsent text', imageIds })
      expect(target.keyboard!.snapshot).toMatchObject({ draft: 'target pending text', imageIds: [] })
      settle({ ok: false, error: { code: 'internal', message: 'retry target', details: {} } })
      await vi.waitFor(() => { expect(target.keyboard!.snapshot.phase).toBe('plain') })
      expect(target.keyboard!.snapshot.draft).toBe('target pending text')
    } finally {
      await b.runtime.dispose()
      created.mockRestore()
    }
  })

  it.each([false, true])('only the latest workspace choice can transfer and open (olderFirst=%s)', async (olderFirst) => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:latest-choice')
    try {
      const OLDER = 'older-workspace-session' as SessionId
      const LATEST = 'latest-workspace-session' as SessionId
      await b.runtime.sessions.add({ id: OLDER }, { current: false })
      await b.runtime.sessions.add({ id: LATEST }, { current: false })
      let finishOlder!: (id: SessionId) => void
      let finishLatest!: (id: SessionId) => void
      const olderConnection = new Promise<SessionId>((resolve) => { finishOlder = resolve })
      const latestConnection = new Promise<SessionId>((resolve) => { finishLatest = resolve })
      b.runtime.workspaces.stub('connectWorkspace', id => id === 'older-workspace' ? olderConnection : latestConnection)
      const source = b.composerApi(ROOT)
      source.keyboard!.setDraft('carry to latest')
      expect(source.addImages!([new File([Uint8Array.of(1)], 'latest.png', { type: 'image/png' })])).toBeNull()
      const imageIds = source.keyboard!.snapshot.imageIds
      const choose = b.residentApi(ROOT).selectWorkspace
      const older = choose('older-workspace' as never)
      const latest = choose('latest-workspace' as never)
      if (olderFirst) {
        finishOlder(OLDER)
        await older
        expect(b.runtime.sessions.calls.filter(call => call.method === 'open')).toEqual([])
        finishLatest(LATEST)
        await latest
      } else {
        finishLatest(LATEST)
        await latest
        finishOlder(OLDER)
        await older
      }
      expect(b.runtime.sessions.calls.filter(call => call.method === 'open'))
        .toEqual([{ method: 'open', args: [LATEST] }])
      expect(b.composerApi(LATEST).keyboard!.snapshot).toMatchObject({ draft: 'carry to latest', imageIds })
      expect(b.composerApi(OLDER).keyboard!.snapshot).toMatchObject({ draft: '', imageIds: [] })
      expect(source.keyboard!.snapshot).toMatchObject({ draft: '', imageIds: [] })
    } finally {
      await b.runtime.dispose()
      created.mockRestore()
    }
  })

  it.each([false, true])('a later session selection invalidates the pending workspace choice (returns=%s)', async (returnToSource) => {
    const b = await bench()
    try {
      const OTHER = 'selected-elsewhere' as SessionId
      const TARGET = 'abandoned-target' as SessionId
      await b.runtime.sessions.add({ id: OTHER }, { current: false })
      await b.runtime.sessions.add({ id: TARGET }, { current: false })
      let finish!: (id: SessionId) => void
      b.runtime.workspaces.stub('connectWorkspace', () => new Promise<SessionId>((resolve) => { finish = resolve }))
      b.inputApi(ROOT).actions.setDraft('keep at source')
      const pending = b.residentApi(ROOT).selectWorkspace('abandoned-workspace' as never)
      await b.runtime.sessions.setCurrent(OTHER)
      if (returnToSource) await b.runtime.sessions.setCurrent(ROOT)
      finish(TARGET)
      await pending
      expect(b.runtime.sessions.calls.filter(call => call.method === 'open')).toEqual([])
      expect(b.inputApi(ROOT).state.getSnapshot().draft).toBe('keep at source')
      expect(b.inputApi(TARGET).state.getSnapshot().draft).toBe('')
    } finally { await b.runtime.dispose() }
  })

  it.each([false, true])('plugin unload cancels pending and retained workspace callbacks (hero=%s)', async (fromHero) => {
    const b = await bench()
    try {
      const TARGET = 'unloaded-target' as SessionId
      await b.runtime.sessions.add({ id: TARGET }, { current: false })
      if (fromHero) await b.runtime.sessions.setCurrent(undefined)
      const choose = b.residentApi(fromHero ? undefined : ROOT).selectWorkspace
      let finish!: (id: SessionId) => void
      b.runtime.workspaces.stub('connectWorkspace', () => new Promise<SessionId>((resolve) => { finish = resolve }))
      const pending = choose('unloaded-workspace' as never)
      await b.feature.dispose()
      finish(TARGET)
      await expect(pending).resolves.toBeUndefined()
      expect(b.runtime.sessions.calls.filter(call => call.method === 'open')).toEqual([])
      await expect(choose('another-workspace' as never)).resolves.toBeUndefined()
      expect(b.runtime.sessions.calls.filter(call => call.method === 'open')).toEqual([])
      expect(b.runtime.workspaces.calls.filter(call => call.method === 'connectWorkspace')).toHaveLength(1)
    } finally { await b.runtime.dispose() }
  })

  it.each([false, true])('a retained callback cannot act for a different current session (hero=%s)', async (fromHero) => {
    const b = await bench()
    try {
      const OTHER = 'new-current' as SessionId
      await b.runtime.sessions.add({ id: OTHER }, { current: false })
      if (fromHero) await b.runtime.sessions.setCurrent(undefined)
      const choose = b.residentApi(fromHero ? undefined : ROOT).selectWorkspace
      await b.runtime.sessions.setCurrent(OTHER)
      b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
      await choose('obsolete-workspace' as never)
      expect(b.runtime.workspaces.calls.filter(call => call.method === 'connectWorkspace')).toEqual([])
      expect(b.runtime.sessions.calls.filter(call => call.method === 'open')).toEqual([])
    } finally { await b.runtime.dispose() }
  })

  it('a latest connection failure does not revive an older choice and permits retry', async () => {
    const b = await bench()
    try {
      const OLDER = 'failed-choice-older' as SessionId
      const LATEST = 'failed-choice-latest' as SessionId
      await b.runtime.sessions.add({ id: OLDER }, { current: false })
      await b.runtime.sessions.add({ id: LATEST }, { current: false })
      let finishOlder!: (id: SessionId) => void
      let failLatest!: (error: Error) => void
      const olderConnection = new Promise<SessionId>((resolve) => { finishOlder = resolve })
      const latestConnection = new Promise<SessionId>((_resolve, reject) => { failLatest = reject })
      b.runtime.workspaces.stub('connectWorkspace', id => id === 'older-workspace' ? olderConnection : latestConnection)
      b.inputApi(ROOT).actions.setDraft('retry latest choice')
      const choose = b.residentApi(ROOT).selectWorkspace
      const older = choose('older-workspace' as never)
      const latest = choose('latest-workspace' as never)
      failLatest(new Error('connection failed'))
      await expect(latest).rejects.toThrow('connection failed')
      finishOlder(OLDER)
      await older
      expect(b.runtime.sessions.calls.filter(call => call.method === 'open')).toEqual([])
      expect(b.inputApi(ROOT).state.getSnapshot().draft).toBe('retry latest choice')
      b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(LATEST))
      await choose('retry-workspace' as never)
      expect(b.runtime.sessions.calls.filter(call => call.method === 'open'))
        .toEqual([{ method: 'open', args: [LATEST] }])
      expect(b.inputApi(LATEST).state.getSnapshot().draft).toBe('retry latest choice')
    } finally { await b.runtime.dispose() }
  })

  it('selectWorkspace edge arms: no-session resident, empty-draft move, connect failure retryable', async () => {
    const b = await bench()
    // No-session resident (hero before any session): connect resolves and
    // navigation proceeds without any draft choreography.
    await b.runtime.sessions.setCurrent(undefined)
    const noSession = b.residentApi(undefined)
    b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(ROOT))
    void noSession.selectWorkspace('workspace-0' as never)
    await vi.waitFor(() => {
      expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [ROOT] })
    })

    // Cross-session connect with an EMPTY draft: no move, no clearing.
    const OTHER = 'b9-other' as SessionId
    await b.runtime.sessions.add({ id: OTHER }, { current: false })
    const resident = b.residentApi(ROOT)
    const { state } = b.inputApi(ROOT)
    expect(state.getSnapshot().draft).toBe('')
    b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(OTHER))
    void resident.selectWorkspace('workspace-3' as never)
    await vi.waitFor(() => {
      expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [OTHER] })
    })
    expect(b.inputApi(OTHER).state.getSnapshot().draft).toBe('')

    // Connect failure: the rejection propagates to the caller (the view owns
    // the rollback) and no further navigation happens.
    const opens = b.runtime.sessions.calls.filter(c => c.method === 'open').length
    b.runtime.workspaces.stub('connectWorkspace', () => Promise.reject(new Error('offline')))
    await expect(b.residentApi(OTHER).selectWorkspace('workspace-4' as never)).rejects.toThrow('offline')
    expect(b.runtime.sessions.calls.filter(c => c.method === 'open')).toHaveLength(opens)
    await b.runtime.dispose()
  })

  it('scopedConversation fails loud when the session resolves no scope', async () => {
    const b = await bench()
    // The chat-view inject resolves the scoped conversation service at inject
    // time: an unlisted session hits the scope() === undefined throw directly.
    const entry = b.entryOf('conversation.view')
    const injectFn = entry.inject as unknown as (sessionId: SessionId, actions: unknown) => unknown
    expect(() => injectFn('never-listed' as SessionId, {})).toThrow(/resolved no scope/)
    await b.runtime.dispose()
  })

  it('views read face projects the ring ledger (subscribe/version through ctx.slots)', async () => {
    const b = await bench()
    const { injected } = b.conversationApi(ROOT)
    const before = injected.views.version()
    const listener = vi.fn()
    const unsub = injected.views.subscribe(listener)
    // A second ring rider (what ui-trajectory does in production).
    const off = b.slots.register(
      { name: 'conversation.view', id: 'chat2', order: 5, label: 'X' } as never, (() => null) as never)
    await Promise.resolve() // ledger notifications batch per microtask
    expect(listener).toHaveBeenCalled()
    expect(injected.views.version()).toBeGreaterThan(before)
    expect(injected.views.list().map(v => v.id)).toEqual(['chat', 'chat2'])
    // Label falls back to the id when a rider declares none.
    const off2 = b.slots.register(
      { name: 'conversation.view', id: 'bare', order: 6 } as never, (() => null) as never)
    expect(injected.views.list().map(v => v.label)).toEqual(['对话', 'X', 'bare'])
    off()
    off2()
    unsub()
    await b.runtime.dispose()
  })
})

describe('details inject API', () => {
  it('details injects the active-view source and close callback; selection rides the shared store', async () => {
    const b = await bench()
    const entry = b.entryOf('details')
    const injected = (entry.inject as unknown as (sessionId: SessionId) => DetailsHostInjected)(ROOT)
    expect(Object.keys(injected)).toEqual(['closeDetails', 'hooks'])
    expect(injected.hooks.detailsView.getSnapshot()).toBe('tool')
    injected.closeDetails()
    expect(b.layoutFake.closeDetails).toHaveBeenCalledTimes(1)
    // The shared handle: details resolves the SAME instance conversation writes.
    const conv = b.runtime.storeOf('conversation.session', ROOT)
    const details = b.runtime.storeOf('details', ROOT)
    expect(details).toBe(conv)
    await b.runtime.dispose()
  })
})
