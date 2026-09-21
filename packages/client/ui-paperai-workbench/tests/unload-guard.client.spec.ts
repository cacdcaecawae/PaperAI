// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { PaperAIWorkbenchController } from '../src/client/controller.ts'
import { documentOpenResult, NODE_HEADING, RESOURCE_ID, SESSION_ID, successfulRemote, WORKSPACE_ID } from './fixtures.client.ts'

/**
 * Read the guard the way the browser asks it: a cancelled unload is an armed guard.
 * Its own spec file because the listener is page-wide, so a controller another
 * test leaves armed would answer this probe.
 */
function unloadBlocked(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe('PaperAIWorkbenchController unload guard', () => {
  it('stays armed for a draft no mounted view still shows, and comes off when nothing is unsaved', async () => {
    const remote = successfulRemote()
    remote.open = vi.fn<typeof remote.open>(async request => ({ ok: true as const, value: documentOpenResult(undefined, {
      resourceId: request.resourceId, documentId: String(request.resourceId).slice('document:'.length) as never,
    }) }))
    const controller = new PaperAIWorkbenchController(remote)
    const store = controller.workbenchStore(SESSION_ID)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    expect(unloadBlocked()).toBe(false)

    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Unsaved introduction' })
    expect(unloadBlocked()).toBe(true)

    // Two further documents push the first past the preview budget: its draft now lives only in the controller.
    const second = 'document:second' as typeof RESOURCE_ID
    const third = 'document:third' as typeof RESOURCE_ID
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, second)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, third)
    expect(store.getSnapshot().retained.map(view => view.document?.resourceId)).toEqual([second])
    expect(store.getSnapshot().edits).toEqual([])
    expect(unloadBlocked()).toBe(true)

    // Reopening restores the draft; dropping it takes the guard off, though its evicted entry is still in the map.
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    expect(store.getSnapshot().edits).toMatchObject([{ draft: 'Unsaved introduction' }])
    controller.cancelEdit(SESSION_ID)
    expect(unloadBlocked()).toBe(false)

    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Typed again' })
    expect(unloadBlocked()).toBe(true)
    controller.dispose()
    expect(unloadBlocked()).toBe(false)
  })
})
