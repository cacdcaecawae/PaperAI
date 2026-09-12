// @vitest-environment jsdom
/**
 * Layout preferences retain widths while open views and responsive state stay transient. Uses the
 * test-sanctioned path: factory self-call + .create() gives the
 * real engine instance (same create path as production).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.preferences'

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes the sidebar at its default width, details closed, wide viewport assumed', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toMatchObject({
      sidebar: SIDEBAR_DEFAULT, details: 0, narrow: false, narrowExpanded: false, detailsFocus: false, conversationFocus: false,
    })
  })

  it('each create() is an independent instance (factory is not a singleton)', () => {
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.setSidebar(400)
    expect(b.store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('setSidebar/setDetails clamp into the contract ranges', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(1)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MIN)
    actions.setSidebar(9999)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MAX)
    actions.setDetails(1)
    expect(store.getSnapshot().details).toBe(DETAILS_MIN)
    actions.setDetails(9999)
    expect(store.getSnapshot().details).toBe(DETAILS_MAX)
  })

  it('reopens the sidebar at the preferred drag width', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(400)
  })

  it('narrow toggleSidebar flips only the re-expand override; the width preference survives', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({
      sidebar: 400, details: 0, narrow: true, narrowExpanded: true, detailsFocus: false, conversationFocus: false,
    })
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(false)
    expect(store.getSnapshot().sidebar).toBe(400)
  })

  it('crossing the breakpoint drops the override; a same-value setNarrow keeps it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(false)
    expect(store.getSnapshot()).toMatchObject({ narrow: false, narrowExpanded: false })
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('openDetails uses the contract default, preserves an open width, and closeDetails zeroes', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.setDetails(500)
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(500)
    actions.closeDetails()
    expect(store.getSnapshot().details).toBe(0)
  })

  it('uses configured details bounds and opening width', () => {
    const geometry = { centerMin: 520, detailsMin: 400, detailsDefault: 600, detailsMax: 960 }
    const { store, actions } = createLayoutStore(geometry).create()
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(600)
    actions.setDetails(1)
    expect(store.getSnapshot().details).toBe(400)
    actions.setDetails(9999)
    expect(store.getSnapshot().details).toBe(960)
  })

  it('restores user widths without reopening stale details or focus', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.openDetails()
    first.actions.setDetails(500)
    first.actions.setDetailsFocus(true)
    first.actions.toggleSidebar()
    expect(localStorage.getItem(PERSIST_KEY)).not.toBeNull()

    const second = createLayoutStore().create()
    expect(second.store.getSnapshot()).toMatchObject({
      sidebar: 0,
      details: 0,
      narrow: false,
      narrowExpanded: false,
      detailsFocus: false,
      conversationFocus: false,
    })
    second.actions.toggleSidebar()
    second.actions.openDetails()
    expect(second.getSnapshot()).toMatchObject({ sidebar: 400, details: 500 })
  })

  it('ignores corrupt stored values and clamps restored widths to the active geometry', () => {
    localStorage.setItem(PERSIST_KEY, '{')
    expect(createLayoutStore().create().getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ sidebarWidth: 9999, detailsWidth: 2000 }))
    const restored = createLayoutStore().create()
    restored.actions.openDetails()
    expect(restored.getSnapshot()).toMatchObject({ sidebar: SIDEBAR_MAX, details: DETAILS_MAX })
  })

  it('setDetailsFocus flips the demand and closeDetails releases it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    actions.setDetailsFocus(true)
    expect(store.getSnapshot()).toMatchObject({ detailsFocus: true })
    actions.closeDetails()
    expect(store.getSnapshot()).toMatchObject({ details: 0, detailsFocus: false })
  })

  it('reveals the conversation without forgetting document width and lets reopening select the document', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    actions.setDetails(500)
    actions.setDetailsFocus(true)
    actions.revealConversation()
    expect(store.getSnapshot()).toMatchObject({ details: 500, detailsFocus: false, conversationFocus: true })
    actions.openDetails()
    expect(store.getSnapshot()).toMatchObject({ details: 500, conversationFocus: false })
  })
})
