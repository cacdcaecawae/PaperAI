// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Modal } from '../src/Modal.tsx'
import { Menu } from '../src/Menu.tsx'

beforeEach(() => {
  // JSDOM does not lay out elements; give the focus library measurable visible controls.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return this.hidden ? [] as unknown as DOMRectList : [new DOMRect(0, 0, 100, 32)] as unknown as DOMRectList
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.style.overflow = '' })

it('traps Tab at both ends and restores focus and the original body scrolling on close', async () => {
  function Example() {
    const [open, setOpen] = useState(false)
    return <><button onClick={() => { setOpen(true) }}>Open</button>
      <Modal open={open} title="Editor" onClose={() => { setOpen(false) }}>
        <input aria-label="Title" /><button>Save</button>
      </Modal></>
  }
  document.body.style.overflow = 'clip'
  render(<Example />)
  const trigger = screen.getByRole('button', { name: 'Open' })
  trigger.focus()
  fireEvent.click(trigger)
  expect(document.body.style.overflow).toBe('hidden')
  const close = screen.getByRole('button', { name: 'Close' })
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  const first = document.activeElement!
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(close, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  await waitFor(() =>{  expect(document.activeElement).toBe(trigger) })
  expect(document.body.style.overflow).toBe('clip')
  document.body.style.overflow = ''
})

it('keeps body-portaled menus inside the focus scope and closes the menu before its dialog', async () => {
  const selected = vi.fn()
  const parentEscape = vi.fn<(event: KeyboardEvent) => void>()
  document.addEventListener('keydown', parentEscape)
  function Example() {
    const [open, setOpen] = useState(true)
    const [menu, setMenu] = useState(false)
    return <Modal open={open} title="Templates" onClose={() => { setOpen(false) }}>
      <Menu portal open={menu} onClose={() => { setMenu(false) }}
        anchor={<button onClick={() => { setMenu(true) }}>Choose template</button>}
        items={[{ id: 'a', label: 'Thesis' }, { id: 'disabled', label: 'Unavailable', disabled: true }, { id: 'b', label: 'Report' }]}
        onSelect={(id) => { selected(id); setMenu(false) }} />
    </Modal>
  }
  try {
    render(<Example />)
    const trigger = screen.getByRole('button', { name: 'Choose template' })
    fireEvent.click(trigger)
    await act(async () => {})
    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Thesis' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Report' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(document.activeElement).toBe(trigger)
    expect(parentEscape.mock.calls.some(([event]) => event.key === 'Escape')).toBe(false)
    fireEvent.click(trigger)
    await act(async () => {})
    fireEvent.click(screen.getByRole('menuitem', { name: 'Thesis' }))
    expect(selected).toHaveBeenCalledWith('a')
    expect(document.activeElement).toBe(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  } finally { document.removeEventListener('keydown', parentEscape) }
})

it('closes only the nested dialog and retains the shared scroll lock until the last dialog closes', async () => {
  function Example() {
    const [outer, setOuter] = useState(true)
    const [inner, setInner] = useState(false)
    return <><Modal open={outer} title="Settings" onClose={() => { setOuter(false) }}>
      <button onClick={() => { setInner(true) }}>Configure</button>
    </Modal><Modal open={inner} title="Agent" onClose={() => { setInner(false) }}>
      <input aria-label="Agent name" />
    </Modal></>
  }
  render(<Example />)
  const trigger = screen.getByRole('button', { name: 'Configure' })
  trigger.focus()
  fireEvent.click(trigger)
  fireEvent.keyDown(within(screen.getByRole('dialog', { name: 'Agent' })).getByRole('button', { name: 'Close' }), { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Agent' })).toBeNull()
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
  expect(document.body.style.overflow).toBe('hidden')
  await waitFor(() =>{  expect(document.activeElement).toBe(trigger) })
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.body.style.overflow).toBe('')
})

it.each(['preventDefault', 'stopPropagation'] as const)('lets a child editor consume Escape with %s before closing the dialog', (method) => {
  const parentEscape = vi.fn()
  document.addEventListener('keydown', parentEscape)
  function Example() {
    const [open, setOpen] = useState(true)
    const [editing, setEditing] = useState(true)
    return <Modal open={open} title="Directory" onClose={() => { setOpen(false) }}>
      {editing ? <input aria-label="Path" onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event[method]()
        setEditing(false)
      }} /> : <button>Edit path</button>}
    </Modal>
  }
  try {
    render(<Example />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()
    parentEscape.mockClear()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Edit path' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(parentEscape).not.toHaveBeenCalled()
  } finally { document.removeEventListener('keydown', parentEscape) }
})
