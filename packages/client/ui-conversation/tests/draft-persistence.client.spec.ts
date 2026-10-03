// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { SessionInputShell } from '../src/client/input/facade.ts'
import type { DraftAttachmentId } from '../src/client/input/contract.ts'
import { createChatStore } from '../src/client/stores.ts'

function input(sink: () => Promise<SubmitOutcome> = async () => ({ kind: 'success' })) {
  return new SessionInputShell({
    actx: {} as ClientContext,
    defaultSink: sink,
    commandImages: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token },
  })
}

function deferred() {
  let resolve!: (result: SubmitOutcome) => void
  const promise = new Promise<SubmitOutcome>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => { localStorage.clear() })

describe('resident draft persistence', () => {
  it('persists accepted text and image consumption before the view returns', async () => {
    const pending = deferred()
    const shell = input(() => pending.promise)
    const chat = createChatStore().create('accepted')
    shell.connectDraftStore(chat.getSnapshot().draft, chat.actions.setDraft)
    shell.setDraft('describe this')
    shell.addImages(['image' as DraftAttachmentId])
    shell.submit()
    pending.resolve({ kind: 'success' })
    await pending.promise
    expect(shell.snapshot).toMatchObject({ draft: '', imageIds: [], phase: 'plain' })
    expect(chat.getSnapshot().draft).toBe('')
    const persisted = JSON.parse(localStorage.getItem('dsh.conversation.chat.accepted')!) as { draft: string }
    expect(persisted.draft).toBe('')
    shell.connectDraftStore('stale rendered value', chat.actions.setDraft)
    shell.undo()
    expect(shell.snapshot.draft).toBe('')
    expect(chat.getSnapshot().draft).toBe('')
  })

  it('retains a rejected draft and images for a later retry', async () => {
    const pending = deferred()
    const shell = input(() => pending.promise)
    const chat = createChatStore().create('rejected')
    shell.connectDraftStore('', chat.actions.setDraft)
    shell.setDraft('retry this')
    shell.addImages(['image' as DraftAttachmentId])
    shell.submit()
    pending.resolve({ kind: 'error', text: 'try again' })
    await pending.promise
    shell.connectDraftStore(chat.getSnapshot().draft, chat.actions.setDraft)
    expect(shell.snapshot).toMatchObject({ draft: 'retry this', imageIds: ['image'], phase: 'plain' })
    expect(chat.getSnapshot().draft).toBe('retry this')
  })

  it('adopts persisted text once on a fresh shell and preserves explicit empty writes', () => {
    const chat = createChatStore().create('restored')
    const restored = input()
    restored.connectDraftStore('unsent text', chat.actions.setDraft)
    expect(restored.snapshot.draft).toBe('unsent text')
    restored.setDraft('')
    restored.connectDraftStore('stale text', chat.actions.setDraft)
    expect(restored.snapshot.draft).toBe('')
    const edited = input()
    edited.setDraft('')
    edited.connectDraftStore('stale text', chat.actions.setDraft)
    expect(edited.snapshot.draft).toBe('')
    expect(chat.getSnapshot().draft).toBe('')
  })

  it('keeps resident reference identity while reconnecting its canonical persistence writer', () => {
    const shell = input()
    const chat = createChatStore().create('reference')
    shell.connectDraftStore('', chat.actions.setDraft)
    shell.setDraft('@res')
    const reference = '@[Research notes](dsh-session:InNvdXJjZSI)'
    expect(shell.insertReference({
      source: 'reference', ref: reference, label: 'Research notes', clipboardText: reference,
    }, { start: 0, end: 4, draftRev: shell.snapshot.draftRev })).toBe(true)
    const occurrences = shell.snapshot.occurrences
    shell.connectDraftStore(chat.getSnapshot().draft, chat.actions.setDraft)
    expect(shell.snapshot.draft).toBe('@Research notes ')
    expect(shell.snapshot.occurrences).toBe(occurrences)
    expect(chat.getSnapshot().draft).toBe(`${reference} `)
  })
})
