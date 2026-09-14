// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { createWorkbenchViewStore } from '../src/client/view-store.ts'

afterEach(() => { localStorage.clear() })

it('remembers explicit collaboration and zoom choices without persisting document content', () => {
  const first = createWorkbenchViewStore().create('example')
  first.actions.setWriting(false)
  first.actions.setZoom(125)
  expect(createWorkbenchViewStore().create('example').getSnapshot()).toEqual({ writing: false, zoom: 125 })
  expect(createWorkbenchViewStore().create('different-session').getSnapshot()).toEqual({ writing: true, zoom: 'fit' })
})

it('recovers from a malformed preference value', () => {
  localStorage.setItem('paperai.workbench.view', 'null')
  expect(createWorkbenchViewStore().create().getSnapshot()).toEqual({ writing: true, zoom: 'fit' })
})
