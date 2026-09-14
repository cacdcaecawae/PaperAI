// @vitest-environment jsdom
import { useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { DocumentPreview } from '../src/client/DocumentPreview.tsx'
import { zh } from '../src/client/locales.ts'
import type { PaperAIBlockDraft, PaperAIBlockEdit, PaperAIDocumentNodeId, PaperAIDocumentSnapshot } from '../src/client/types.ts'
import type { PaperAIDocumentWorkbenchProps } from '../src/client/slots.ts'
import { readParagraphs } from '../src/client/editor-dom.ts'
import { runsOf } from '../src/client/preview-html.ts'
import { PaperAIWorkbenchController } from '../src/client/controller.ts'
import { commitFormatting } from '../src/client/format-intent.ts'
import { NODE_HEADING, NODE_PARAGRAPH, RESOURCE_ID, REVISION_1, SESSION_ID, WORKSPACE_ID, successfulRemote } from './fixtures.client.ts'

afterEach(cleanup)
// jsdom exposes InputEvent but does not implement the browser's target-range method.
Object.defineProperty(InputEvent.prototype, 'getTargetRanges', { configurable: true, value: () => [] })
const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}) as PaperAIDocumentWorkbenchProps['t']

function setup(body = '<p data-path="/body/p[1]" style="font-size:12pt;font-family:Arial">Hello world</p>', texts = ['Hello world'], comparing = false,
  paragraphStyles: PaperAIDocumentSnapshot['paragraphStyles'] = [{ id: 'Normal', name: '正文' }, { id: 'SectionTitle', name: '章节标题' }]) {
  const onDraft = vi.fn()
  const onSave = vi.fn()
  const nodes = texts.map((text, index) => ({ nodeId: `node-${index}` as PaperAIDocumentNodeId, text, label: text, kind: 'paragraph' as const, depth: 0, editable: true }))
  function Harness() {
    const [edits, setEdits] = useState<PaperAIBlockEdit[]>([])
    return <DocumentPreview html={body} revision={REVISION_1} nodes={nodes} title="Document" edits={edits} saving={false} t={t} onSave={onSave}
      comparing={comparing} paragraphStyles={paragraphStyles}
      onCancel={() =>{  setEdits([]) }} onDraft={(nodeId, draft) => {
        onDraft(nodeId, draft)
        setEdits(current => [...current.filter(edit => edit.nodeId !== nodeId), ...(draft === null ? [] : [{
          nodeId, baseText: nodes.find(node => node.nodeId === nodeId)?.text ?? '', draft: draft.text,
          ...(draft.runs === undefined ? {} : { runs: draft.runs }),
          ...(draft.paragraphs === undefined ? {} : { paragraphs: draft.paragraphs }),
          ...(draft.formatting === undefined ? {} : { formatting: draft.formatting }),
        }])])
      }} />
  }
  const view = render(<Harness />)
  const shadow = view.container.querySelector('[role="document"]')!.shadowRoot!
  let current: Range | null = null
  Object.defineProperty(shadow, 'getSelection', { value: () => ({
    get rangeCount() { return current === null ? 0 : 1 },
    getRangeAt: () => current,
    removeAllRanges: () => { current = null },
    addRange: (range: Range) => { current = range },
  }) })
  const select = (start: Node, startOffset: number, end = start, endOffset = startOffset): Range => {
    const range = document.createRange()
    range.setStart(start, startOffset); range.setEnd(end, endOffset); current = range
    const element = (start instanceof HTMLElement ? start : start.parentElement)!
    const block = element.closest<HTMLElement>('[data-paperai-block]') ?? element
    act(() => { block.focus(); fireEvent.keyUp(block, { key: 'Shift' }) })
    return range
  }
  return { shadow, onDraft, onSave, select, getRange: () => current, paragraphs: () => [...shadow.querySelectorAll<HTMLElement>('[data-paperai-block]')] }
}

describe('Document editing commands', () => {
  it.each(['typing', 'bold', 'unbold'] as const)('keeps rendered fonts in the draft but sends only %s intent through the controller', async (action) => {
    const editor = setup('<p data-path="/body/p[1]" style="font-family:Calibri;font-size:12pt">'
      + `<span style="font-family:Times New Roman;${action === 'unbold' ? 'font-weight:bold;' : ''}">Research</span>`
      + '<span style="font-family:Times New Roman"> back</span><span style="font-family:Times New Roman">ground</span></p>', ['Research background'])
    const block = editor.paragraphs()[0]!
    const last = block.lastChild!.firstChild!
    editor.select(last, last.textContent!.length)
    last.nodeValue = `${last.nodeValue!}!`
    fireEvent.input(block)
    if (action !== 'typing') {
      editor.select(block.firstChild!.firstChild!, 0, block.firstChild!.firstChild!, 3)
      fireEvent.click(screen.getByRole('button', { name: zh['block.bold'] }))
      const formatted = editor.onDraft.mock.lastCall?.[1] as PaperAIBlockDraft
      fireEvent.click(screen.getByRole('button', { name: zh['editor.undo'] }))
      fireEvent.click(screen.getByRole('button', { name: zh['editor.redo'] }))
      expect(editor.onDraft.mock.lastCall?.[1]).toEqual(formatted)
    }
    const draft = editor.onDraft.mock.lastCall?.[1] as PaperAIBlockDraft
    expect(draft.runs?.every(run => run.font === 'Times New Roman')).toBe(true)
    const remote = successfulRemote()
    const commit = vi.spyOn(remote, 'commit')
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    controller.updateDraft(SESSION_ID, NODE_PARAGRAPH, draft)
    expect(controller.workbenchStore(SESSION_ID).getSnapshot().edits[0]?.formatting).toEqual(draft.formatting)
    await controller.commitEdit(SESSION_ID)
    const mutation = commit.mock.calls[0]![0].mutations[0]!
    expect(mutation.nextText).toBe('Research background!')
    expect(mutation.runs).toEqual(action === 'typing' ? undefined : [
      { text: 'Res', bold: action === 'bold' }, { text: 'earch background!' },
    ])
    expect(mutation).not.toHaveProperty('formatting')
    controller.dispose()
  })

  it('retains an empty insertion seed through a complete draft repaint before further typing', () => {
    const editor = setup('<p data-path="/body/p[1]"><span style="font-family:Arial;font-size:18pt;font-weight:bold">Hello world</span></p>')
    const block = editor.paragraphs()[0]!
    editor.select(block.querySelector('span')!.firstChild!, 11)
    fireEvent.keyDown(block, { key: 'Enter' })
    const empty = block.querySelectorAll<HTMLElement>('[data-paperai-paragraph]')[1]!
    act(() => { block.blur(); fireEvent.input(block) })
    const repainted = block.querySelectorAll<HTMLElement>('[data-paperai-paragraph]')[1]!
    expect(repainted).not.toBe(empty)
    const seed = repainted.querySelector('br[data-paperai-placeholder]')!.parentElement!
    expect(seed.style.fontWeight).toBe('bold')
    expect(seed.style.fontFamily).toBe('Arial')
    expect(seed.style.fontSize).toBe('18pt')
    editor.select(seed.firstChild!, 0)
    seed.firstChild!.nodeValue = 'Continued'
    fireEvent.input(block)
    const draft = editor.onDraft.mock.lastCall?.[1] as PaperAIBlockDraft
    expect(draft.paragraphs?.[1]?.runs).toEqual([expect.objectContaining({ text: 'Continued', bold: true, font: 'Arial' })])
    expect(commitFormatting({ nodeId: NODE_PARAGRAPH, baseText: 'Hello world', draft: draft.text,
      paragraphs: draft.paragraphs!, formatting: draft.formatting! })).toEqual({ paragraphs: [{ text: 'Hello world' }, { text: 'Continued' }] })
  })

  it('routes shared-host input, composition and keyboard commands to the selected original block', () => {
    const editor = setup('<p data-path="/body/p[1]">Hello</p><p data-path="/body/p[2]">World</p>', ['Hello', 'World'])
    const [first, second] = editor.paragraphs()
    const container = editor.shadow.querySelector<HTMLElement>('.paperai-doc')!
    expect(container.getAttribute('contenteditable')).toBe('true')
    expect([first, second].map(block => block!.getAttribute('contenteditable'))).toEqual(['true', 'true'])
    editor.select(second!.firstChild!, 3)
    fireEvent.compositionStart(container)
    second!.firstChild!.nodeValue = 'Wor中文ld'
    fireEvent.input(container, { isComposing: true })
    expect(editor.onDraft).not.toHaveBeenCalled()
    fireEvent.compositionEnd(container)
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-1', { text: 'Wor中文ld' })
    editor.select(second!.firstChild!, 5)
    fireEvent.keyDown(container, { key: 'Enter' })
    expect(readParagraphs(second!).map(part => part.text)).toEqual(['Wor中文', 'ld'])
    expect(first!.textContent).toBe('Hello')
    fireEvent.keyDown(container, { key: 'z', ctrlKey: true })
    expect(readParagraphs(second!).map(part => part.text)).toEqual(['Wor中文ld'])
  })

  it.each([
    'deleteContentBackward', 'deleteWordBackward', 'deleteSoftLineBackward',
    'deleteContentForward', 'deleteWordForward', 'deleteSoftLineForward',
  ])('prevents %s from merging original blocks while permitting an interior deletion', (inputType) => {
    const editor = setup('<p data-path="/body/p[1]">Hello</p><p data-path="/body/p[2]">World</p>', ['Hello', 'World'])
    const [first, second] = editor.paragraphs()
    const container = editor.shadow.querySelector<HTMLElement>('.paperai-doc')!
    const backward = inputType.endsWith('Backward')
    const text = (backward ? second : first)!.firstChild!
    editor.select(text, backward ? 0 : 5)
    expect(fireEvent(container, new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }))).toBe(false)
    expect(editor.onDraft).not.toHaveBeenCalled()
    expect([first, second].map(block => block!.textContent)).toEqual(['Hello', 'World'])
    editor.select(text, 2)
    expect(fireEvent(container, new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }))).toBe(true)
    text.nodeValue = 'Interior edit'
    fireEvent.input(container)
    expect(editor.onDraft).toHaveBeenLastCalledWith(backward ? 'node-1' : 'node-0', { text: 'Interior edit' })
  })

  it('rejects native target ranges spanning originals and drag/drop mutations', () => {
    const editor = setup('<p data-path="/body/p[1]">Hello</p><p data-path="/body/p[2]">World</p>', ['Hello', 'World'])
    const [first, second] = editor.paragraphs()
    const container = editor.shadow.querySelector<HTMLElement>('.paperai-doc')!
    editor.select(first!.firstChild!, 2)
    const event = new InputEvent('beforeinput', { inputType: 'deleteContentForward', bubbles: true, cancelable: true })
    Object.defineProperty(event, 'getTargetRanges', { value: () => [{
      startContainer: first!.firstChild!, startOffset: 2, endContainer: second!.firstChild!, endOffset: 1,
    }] })
    expect(fireEvent(container, event)).toBe(false)
    for (const inputType of ['insertFromDrop', 'deleteByDrag']) {
      expect(fireEvent(container, new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }))).toBe(false)
    }
    expect(editor.onDraft).not.toHaveBeenCalled()
  })

  it('allows deletion between empty draft paragraphs belonging to one original block', () => {
    const editor = setup()
    const block = editor.paragraphs()[0]!
    const container = editor.shadow.querySelector<HTMLElement>('.paperai-doc')!
    editor.select(block, 0, block, block.childNodes.length)
    fireEvent.paste(block, { clipboardData: { getData: () => '\n\n' } })
    const parts = [...block.querySelectorAll<HTMLElement>('[data-paperai-paragraph]')]
    editor.select(parts[1]!, 0)
    for (const inputType of ['deleteContentBackward', 'deleteContentForward']) {
      expect(fireEvent(container, new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }))).toBe(true)
    }
    editor.select(parts[0]!, 0)
    expect(fireEvent(container, new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }))).toBe(false)
    editor.select(parts[2]!, 0)
    expect(fireEvent(container, new InputEvent('beforeinput', { inputType: 'deleteContentForward', bubbles: true, cancelable: true }))).toBe(false)
  })

  it('protects unmapped subtrees and restores rejected IME changes outside block tags without replacing mapped nodes', () => {
    const editor = setup('Bare text<div class="header">Header<img src="safe.png"></div><p data-path="/body/p[1]">Hello</p>', ['Hello'])
    const container = editor.shadow.querySelector<HTMLElement>('.paperai-doc')!
    const block = editor.paragraphs()[0]!
    const header = container.querySelector<HTMLElement>('.header')!
    const image = header.querySelector('img')!
    const bare = container.firstChild!
    expect(header.getAttribute('contenteditable')).toBe('false')
    editor.select(block.firstChild!, 5)
    block.firstChild!.nodeValue = 'Hello draft'
    fireEvent.input(container)
    editor.onDraft.mockClear()
    editor.select(bare, 2)
    expect(fireEvent(container, new InputEvent('beforeinput', { inputType: 'insertText', bubbles: true, cancelable: true }))).toBe(false)
    fireEvent.compositionStart(container)
    bare.nodeValue = 'Corrupt bare text'
    header.replaceChildren(document.createTextNode('Corrupt header'))
    block.remove()
    container.append(document.createTextNode('Inserted outside any block'))
    fireEvent.input(container, { isComposing: true })
    fireEvent.compositionEnd(container)
    expect(container.firstChild).toBe(bare)
    expect(bare.nodeValue).toBe('Bare text')
    expect(header.textContent).toBe('Header')
    expect(header.querySelector('img')).toBe(image)
    expect(editor.paragraphs()[0]).toBe(block)
    expect(block.textContent).toBe('Hello draft')
    expect(container.textContent).toBe('Bare textHeaderHello draft')
    expect(editor.onDraft).not.toHaveBeenCalled()
    editor.select(block.firstChild!, 5)
    fireEvent.keyDown(container, { key: 'z', ctrlKey: true })
    expect(block.textContent).toBe('Hello')
  })

  it('keeps both existing drafts and their selection through synchronous store updates, formatting, and undo/redo', async () => {
    const controller = new PaperAIWorkbenchController(successfulRemote())
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    const store = controller.workbenchStore(SESSION_ID)
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Changed heading' })
    controller.updateDraft(SESSION_ID, NODE_PARAGRAPH, { text: 'Changed paragraph' })
    function Live() {
      const state = useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())
      return <DocumentPreview html={state.document!.previewHtml} revision={state.document!.revision} nodes={state.document!.nodes}
        paragraphStyles={state.document!.paragraphStyles}
        title="Document" edits={state.edits} saving={false} t={t} onSave={() => {}} onCancel={() => {}}
        onDraft={(id, draft) => { flushSync(() => { controller.updateDraft(SESSION_ID, id, draft) }) }} />
    }
    const view = render(<Live />)
    const shadow = view.container.querySelector('[role="document"]')!.shadowRoot!
    const [first, second] = [...shadow.querySelectorAll<HTMLElement>('[data-paperai-block][contenteditable]')]
    let range = document.createRange()
    range.setStart(first!, 0); range.setEnd(second!, second!.childNodes.length)
    Object.defineProperty(shadow, 'getSelection', { value: () => ({
      rangeCount: 1, getRangeAt: () => range, removeAllRanges: () => {}, addRange: (next: Range) => { range = next },
    }) })
    act(() => { first!.focus() })
    fireEvent.keyUp(first!, { key: 'Shift' })
    fireEvent.click(screen.getByRole('button', { name: zh['block.bold'] }))
    fireEvent.change(screen.getByRole('combobox', { name: zh['editor.size'] }), { target: { value: '18pt' } })
    expect(store.getSnapshot().edits.find(edit => edit.nodeId === NODE_PARAGRAPH)?.runs)
      .toEqual([{ text: 'Changed paragraph', bold: true, size: '18pt' }])
    expect(runsOf(second!)).toEqual([{ text: 'Changed paragraph', bold: true, size: '18pt' }])
    expect(first!.contains(range.startContainer)).toBe(true)
    expect(second!.contains(range.endContainer)).toBe(true)
    expect(range.toString()).toBe('Changed headingChanged paragraph')
    fireEvent.click(screen.getByRole('button', { name: zh['editor.paragraph'] }))
    fireEvent.change(screen.getByRole('combobox', { name: zh['editor.align'] }), { target: { value: 'center' } })
    const formatted = store.getSnapshot().edits
    expect(formatted.map(edit => edit.paragraphs?.[0]?.format)).toEqual([{ align: 'center' }, { align: 'center' }])
    expect(formatted.map(edit => edit.paragraphs?.[0]?.runs?.[0]?.size)).toEqual(['18pt', '18pt'])
    expect([first, second].map(block => readParagraphs(block!)[0]?.format)).toEqual([{ align: 'center' }, { align: 'center' }])
    fireEvent.click(screen.getByRole('button', { name: zh['editor.undo'] }))
    expect(store.getSnapshot().edits.map(edit => edit.paragraphs)).toEqual([undefined, undefined])
    expect([first, second].map(block => runsOf(block!)[0]?.size)).toEqual(['18pt', '18pt'])
    fireEvent.click(screen.getByRole('button', { name: zh['editor.undo'] }))
    expect(store.getSnapshot().edits.map(edit => edit.runs?.[0]?.size)).toEqual([undefined, undefined])
    expect([first, second].map(block => runsOf(block!)[0]?.size)).toEqual([undefined, undefined])
    fireEvent.click(screen.getByRole('button', { name: zh['editor.redo'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['editor.redo'] }))
    expect(store.getSnapshot().edits).toEqual(formatted)
    expect([first, second].map(block => readParagraphs(block!)[0]?.format)).toEqual([{ align: 'center' }, { align: 'center' }])
    expect([first, second].map(block => runsOf(block!)[0]?.size)).toEqual(['18pt', '18pt'])
    controller.dispose()
  })

  it('finds text across formatted runs, advances through repeated matches, and wraps without editing', () => {
    const editor = setup('<p data-path="/body/p[1]"><span>Hel</span><b>lo world</b> Hello world</p>'
      + '<p data-path="/body/p[2]">Another Hello world</p>', ['Hello world Hello world', 'Another Hello world'])
    const [first, second] = editor.paragraphs()
    const firstScroll = vi.fn()
    const secondScroll = vi.fn()
    first!.scrollIntoView = firstScroll
    second!.scrollIntoView = secondScroll
    fireEvent.click(screen.getByRole('button', { name: zh['editor.find'] }))
    const query = screen.getByRole('textbox', { name: zh['editor.findPlaceholder'] })
    const next = screen.getByRole<HTMLButtonElement>('button', { name: zh['editor.findNext'] })
    expect(next.disabled).toBe(true)
    fireEvent.change(query, { target: { value: 'missing' } })
    fireEvent.keyDown(query, { key: 'Enter' })
    expect(screen.getByRole('status').textContent).toBe(zh['editor.findNone'])
    fireEvent.change(query, { target: { value: 'Hello world' } })
    expect(screen.queryByRole('status')).toBeNull()
    expect(fireEvent.keyDown(query, { key: 'ArrowRight' })).toBe(true)
    fireEvent.keyDown(query, { key: 'Enter' })
    expect(editor.getRange()?.toString()).toBe('Hello world')
    expect(editor.getRange()?.startContainer).toBe(first!.querySelector('span')!.firstChild)
    fireEvent.click(next)
    expect(editor.getRange()?.startContainer).toBe(first!.lastChild)
    fireEvent.click(next)
    expect(editor.getRange()?.startContainer).toBe(second!.firstChild)
    fireEvent.click(next)
    expect(editor.getRange()?.startContainer).toBe(first!.querySelector('span')!.firstChild)
    expect(firstScroll).toHaveBeenCalledWith({ block: 'center' })
    expect(secondScroll).toHaveBeenCalledOnce()
    expect(editor.onDraft).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['editor.find'] }))
    expect(screen.queryByRole('search')).toBeNull()
  })

  it('applies font and size to a selection, preserves it for undo/redo, and handles formatting and save shortcuts', () => {
    const editor = setup()
    const block = editor.paragraphs()[0]!
    editor.select(block, 0, block, block.childNodes.length)
    fireEvent.change(screen.getByRole('combobox', { name: zh['editor.font'] }), { target: { value: 'Times New Roman' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh['editor.size'] }), { target: { value: '18pt' } })
    expect(runsOf(block)).toEqual([{ text: 'Hello world', font: 'Times New Roman', size: '18pt' }])
    expect(screen.getByRole('combobox', { name: zh['editor.font'] }).getAttribute('title')).toContain(zh['editor.explicit'])
    const undo = screen.getByRole('button', { name: zh['editor.undo'] })
    expect(fireEvent.mouseDown(undo)).toBe(false)
    fireEvent.click(undo)
    expect(runsOf(block)).toEqual([{ text: 'Hello world', font: 'Times New Roman' }])
    const redo = screen.getByRole('button', { name: zh['editor.redo'] })
    expect(fireEvent.mouseDown(redo)).toBe(false)
    fireEvent.click(redo)
    expect(runsOf(block)[0]?.size).toBe('18pt')
    editor.select(block, 0, block, block.childNodes.length)
    for (const key of ['b', 'i', 'u']) fireEvent.keyDown(block, { key, ctrlKey: true })
    expect(runsOf(block)[0]).toMatchObject({ bold: true, italic: true, underline: true })
    fireEvent.keyDown(block, { key: 's', ctrlKey: true })
    fireEvent.keyDown(block, { key: 'Enter', metaKey: true })
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: zh['block.save'] }))
    expect(editor.onSave).toHaveBeenCalledTimes(3)
    fireEvent.keyDown(block, { key: 'Escape' })
    expect(runsOf(block)).toEqual([{ text: 'Hello world' }])
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-0', null)
  })

  it('submits paragraph style, spacing and indentation while native controls retain their arrow keys', () => {
    const editor = setup()
    const block = editor.paragraphs()[0]!
    editor.select(block.firstChild!, 3)
    fireEvent.click(screen.getByRole('button', { name: zh['editor.paragraph'] }))
    const styles = screen.getByRole('combobox', { name: zh['editor.style'] })
    expect(within(styles).getAllByRole('option').map(option => option.textContent)).toEqual([zh['editor.applyStyle'], '正文', '章节标题'])
    fireEvent.change(styles, { target: { value: 'SectionTitle' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh['editor.spacing'] }), { target: { value: '2x' } })
    const indent = screen.getByRole('spinbutton', { name: zh['editor.indent'] })
    fireEvent.change(indent, { target: { value: '24' } })
    expect(readParagraphs(block)[0]?.format).toEqual({ style: 'SectionTitle', lineSpacing: '2x', indent: '24pt' })
    expect(block.style.marginLeft).toBe('24pt')
    expect(block.style.lineHeight).toBe('2')
    expect(fireEvent.keyDown(indent, { key: 'ArrowLeft' })).toBe(true)
    const calls = editor.onDraft.mock.calls.length
    fireEvent.change(indent, { target: { value: '' } })
    expect(editor.onDraft).toHaveBeenCalledTimes(calls)
    act(() => { indent.focus() })
    fireEvent.keyDown(indent, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: zh['editor.align'] }))
  })

  it.each([undefined, 'ImportedStyle'])('disables an empty style catalog while retaining the current reading %s', (style) => {
    const editor = setup('<p data-path="/body/p[1]">Hello world</p>', ['Hello world'], false, [])
    const block = editor.paragraphs()[0]!
    if (style !== undefined) block.dataset.paperaiFormat = JSON.stringify({ style })
    editor.select(block.firstChild!, 2)
    fireEvent.click(screen.getByRole('button', { name: zh['editor.paragraph'] }))
    const styles = screen.getByRole<HTMLSelectElement>('combobox', { name: zh['editor.style'] })
    expect(styles.disabled).toBe(true)
    expect(styles.value).toBe(style ?? '')
    expect(styles.selectedOptions[0]?.textContent).toBe(style ?? zh['editor.applyStyle'])
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: zh['editor.align'] }).disabled).toBe(false)
    expect(within(styles).queryByRole('option', { name: 'Heading1' })).toBeNull()
  })

  it('navigates version changes in both directions and keeps comparison text read-only', () => {
    const editor = setup('<p data-path="/body/p[1]" data-paperai-change>First</p>'
      + '<p data-path="/body/p[2]" data-paperai-change>Second</p>', ['First', 'Second'], true)
    const [first, second] = editor.paragraphs()
    const firstScroll = vi.fn()
    first!.scrollIntoView = firstScroll
    second!.scrollIntoView = vi.fn()
    expect(editor.shadow.querySelector('[contenteditable]')).toBeNull()
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(screen.getByText('第 1 / 2 处变化')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['versions.next'] }))
    expect(second!.hasAttribute('data-paperai-current')).toBe(true)
    expect(screen.getByText('第 2 / 2 处变化')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['versions.next'] }))
    expect(first!.hasAttribute('data-paperai-current')).toBe(true)
    expect(second!.hasAttribute('data-paperai-current')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh['versions.prev'] }))
    expect(second!.hasAttribute('data-paperai-current')).toBe(true)
    expect(firstScroll).toHaveBeenCalledWith({ block: 'center' })
    expect(editor.onDraft).not.toHaveBeenCalled()
  })

  it('keeps Enter undo history through production controller draft updates', async () => {
    const controller = new PaperAIWorkbenchController(successfulRemote())
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    const store = controller.workbenchStore(SESSION_ID)
    const before = store.getSnapshot().document!.nodes
    function Live() {
      const state = useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())
      return <DocumentPreview html={state.document!.previewHtml} revision={state.document!.revision} nodes={state.document!.nodes} title="Document"
        paragraphStyles={state.document!.paragraphStyles}
        edits={state.edits} saving={false} t={t} onSave={() => {}}
        onCancel={() => { controller.cancelEdit(SESSION_ID) }}
        onDraft={(id, draft) => { controller.updateDraft(SESSION_ID, id, draft) }} />
    }
    const view = render(<Live />)
    const shadow = view.container.querySelector('[role="document"]')!.shadowRoot!
    const block = shadow.querySelector<HTMLElement>('p[contenteditable]')!
    let range = document.createRange()
    range.setStart(block.firstChild!, 5); range.collapse(true)
    Object.defineProperty(shadow, 'getSelection', { value: () => ({
      rangeCount: 1, getRangeAt: () => range, removeAllRanges: () => {}, addRange: (next: Range) => { range = next },
    }) })
    act(() => { block.focus() })
    fireEvent.keyUp(block, { key: 'Shift' })
    fireEvent.keyDown(block, { key: 'Enter' })
    expect(store.getSnapshot().document!.nodes).toBe(before)
    expect(store.getSnapshot().edits).toHaveLength(1)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['editor.undo'] }).disabled).toBe(false)
    fireEvent.keyDown(block, { key: 'z', ctrlKey: true })
    expect(store.getSnapshot().edits).toEqual([])
    controller.dispose()
  })

  it('keeps the ribbon visible and displays inherited caret font and size', () => {
    const editor = setup()
    expect(screen.getByRole('toolbar', { name: zh['editor.ribbon'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['block.bold'] }).hasAttribute('disabled')).toBe(true)
    const block = editor.paragraphs()[0]!
    editor.select(block.firstChild!, 2)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: zh['editor.size'] }).value).toBe('12pt')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: zh['editor.font'] }).value).toBe('Arial')
    expect(screen.getByText(zh['editor.insertion'])).toBeTruthy()
    expect(editor.onDraft).not.toHaveBeenCalled()
    const bold = screen.getByRole('button', { name: zh['block.bold'] })
    act(() => { bold.focus() })
    expect(fireEvent.keyDown(bold, { key: 'Home' })).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: zh['editor.font'] }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: zh['editor.size'] }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(bold)
    expect(screen.getByRole('toolbar').querySelectorAll('[tabindex="0"]').length).toBe(1)
  })

  it('splits at Enter, keeps formatted text, and undoes/redoes the complete draft operation', () => {
    const editor = setup('<p data-path="/body/p[1]"><span style="font-weight:bold">Hello world</span></p>')
    const block = editor.paragraphs()[0]!
    editor.select(block.querySelector('span')!.firstChild!, 5)
    fireEvent.keyDown(block, { key: 'Enter' })
    expect(readParagraphs(block).map(part => part.text)).toEqual(['Hello', ' world'])
    expect(readParagraphs(block)[1]?.runs).toEqual([{ text: ' world', bold: true }])
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-0', expect.objectContaining({ text: 'Hello\n world' }))
    fireEvent.keyDown(block, { key: 'z', ctrlKey: true })
    expect(block.textContent).toBe('Hello world')
    expect(block.querySelector('[data-paperai-paragraph]')).toBeNull()
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-0', null)
    fireEvent.keyDown(block, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(readParagraphs(block).map(part => part.text)).toEqual(['Hello', ' world'])
  })

  it('inserts a soft break and preserves every plain-text line pasted into one block', () => {
    const editor = setup()
    const block = editor.paragraphs()[0]!
    editor.select(block.firstChild!, 5)
    fireEvent.keyDown(block, { key: 'Enter', shiftKey: true })
    expect(runsOf(block).map(run => run.text).join('')).toBe('Hello\v world')
    editor.select(block, 0, block, block.childNodes.length)
    fireEvent.paste(block, { clipboardData: { getData: () => '第一段\r\n第二段\n第三段' } })
    expect(readParagraphs(block).map(part => part.text)).toEqual(['第一段', '第二段', '第三段'])
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-0', expect.objectContaining({ text: '第一段\n第二段\n第三段' }))
    editor.select(block, 0, block, block.childNodes.length)
    fireEvent.paste(block, { clipboardData: { getData: () => '整段重贴\n第二行' } })
    expect(readParagraphs(block).map(part => part.text)).toEqual(['整段重贴', '第二行'])
    fireEvent.keyDown(block, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(block, { key: 'z', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(block, { key: 'Enter', shiftKey: true })
    expect(readParagraphs(block).map(part => part.text)).toEqual(['整段重贴', '第二行\v'])
    expect(block.querySelectorAll('[data-paperai-placeholder]')).toHaveLength(1)
    fireEvent.keyDown(block, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(block, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(editor.getRange()?.startContainer.childNodes[editor.getRange()!.startOffset])
      .toBe(block.querySelector('[data-paperai-placeholder]'))
    const insertion = document.createTextNode('软换行')
    editor.getRange()!.insertNode(insertion)
    fireEvent.input(block)
    expect(readParagraphs(block).map(part => part.text)).toEqual(['整段重贴', '第二行\v软换行'])
  })

  it('keeps paragraph layout and the insertion font through Enter and pasted paragraphs', () => {
    const editor = setup('<p data-path="/body/p[1]"><span style="font-family:Arial;font-weight:bold">Hello world</span></p>')
    const block = editor.paragraphs()[0]!
    editor.select(block.querySelector('span')!.firstChild!, 5)
    fireEvent.click(screen.getByRole('button', { name: zh['editor.paragraph'] }))
    fireEvent.change(screen.getByLabelText(zh['editor.align']), { target: { value: 'center' } })
    fireEvent.change(screen.getByLabelText(zh['editor.spacing']), { target: { value: '1.5x' } })
    fireEvent.keyDown(block, { key: 'Enter' })
    fireEvent.paste(block, { clipboardData: { getData: () => '新增\n下一段' } })
    const paragraphs = readParagraphs(block)
    expect(paragraphs.map(part => part.text)).toEqual(['Hello', '新增', '下一段 world'])
    expect(paragraphs.map(part => part.format)).toEqual(Array.from({ length: 3 }, () => ({ align: 'center', lineSpacing: '1.5x' })))
    expect(paragraphs[1]?.runs).toEqual([{ text: '新增', font: 'Arial', bold: true }])
  })

  it('keeps a cleared font cleared on both sides of Enter without storing the browser font', () => {
    const editor = setup('<p data-path="/body/p[1]" style="font-family:-apple-system,sans-serif"><span style="font-family:Arial">Hello world</span></p>')
    const block = editor.paragraphs()[0]!
    expect(within(screen.getByRole('combobox', { name: zh['editor.font'] })).getByRole('option', { name: '—' })).toBeTruthy()
    editor.select(block, 0, block, block.childNodes.length)
    fireEvent.click(screen.getByRole('button', { name: zh['editor.clear'] }))
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: zh['editor.font'] }).value).toBe('')
    expect(within(screen.getByRole('combobox', { name: zh['editor.font'] })).getByRole('option', { name: zh['editor.fontUnspecified'] })).toBeTruthy()
    const text = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode()!
    editor.select(text, 5)
    fireEvent.keyDown(block, { key: 'Enter' })
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-0', expect.objectContaining({ paragraphs: [
      { text: 'Hello', runs: [{ text: 'Hello', font: '' }] },
      { text: ' world', runs: [{ text: ' world', font: '' }] },
    ] }))
  })

  it('lets IME Enter complete composition and records one undoable draft at composition end', () => {
    const editor = setup()
    const block = editor.paragraphs()[0]!
    editor.select(block.firstChild!, 5)
    fireEvent.compositionStart(block)
    block.textContent = 'Hello中文 world'
    fireEvent.input(block, { isComposing: true, inputType: 'insertCompositionText' })
    expect(fireEvent.keyDown(block, { key: 'Enter', isComposing: true })).toBe(true)
    expect(editor.onDraft).not.toHaveBeenCalled()
    fireEvent.compositionEnd(block)
    expect(editor.onDraft).toHaveBeenCalledTimes(1)
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-0', { text: 'Hello中文 world' })
    fireEvent.keyDown(block, { key: 'z', ctrlKey: true })
    expect(block.textContent).toBe('Hello world')
  })

  it('rejects cross-block IME replacement and restores non-cancelable composition mutations', () => {
    const editor = setup('<p data-path="/body/p[1]">Hello</p><p data-path="/body/p[2]">World</p>', ['Hello', 'World'])
    const [first, second] = editor.paragraphs()
    editor.select(first!.firstChild!, 0, second!.firstChild!, 5)
    fireEvent.compositionStart(first!)
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, isComposing: true, inputType: 'insertCompositionText' })
    expect(fireEvent(first!, event)).toBe(false)
    first!.textContent = '中文'
    second!.remove()
    fireEvent.input(first!, { isComposing: true })
    fireEvent.compositionEnd(first!)
    expect(first!.textContent).toBe('Hello')
    expect(second!.isConnected).toBe(true)
    expect(second!.textContent).toBe('World')
    expect(editor.onDraft).not.toHaveBeenCalled()
  })

  it('sanitizes source markup before editable history can retain or restore it', () => {
    const editor = setup('<script>throw new Error("bad")</script>'
      + '<p data-path="/body/p[1]" onclick="alert(1)" data-paperai-format="invalid">Hello world</p>'
      + '<p data-path="/body/p[2]" contenteditable="true"><a href="javascript:alert(1)">Protected</a></p>', ['Hello world', 'Protected'])
    const [first, second] = editor.paragraphs()
    expect(editor.shadow.querySelector('script')).toBeNull()
    expect(editor.shadow.querySelector('a')?.getAttribute('href')).toBeNull()
    expect(second!.getAttribute('contenteditable')).toBe('false')
    editor.select(first!.firstChild!, 0, first!.firstChild!, 5)
    fireEvent.click(screen.getByRole('button', { name: zh['block.bold'] }))
    fireEvent.keyDown(first!, { key: 'z', ctrlKey: true })
    expect(first!.hasAttribute('onclick')).toBe(false)
    expect(first!.hasAttribute('data-paperai-format')).toBe(false)
    expect(first!.textContent).toBe('Hello world')
  })

  it('reports mixed formatting across blocks and applies one command to both', () => {
    const editor = setup('<p data-path="/body/p[1]">Hello</p><p data-path="/body/p[2]"><span style="font-weight:bold">World</span></p>', ['Hello', 'World'])
    const [first, second] = editor.paragraphs()
    editor.select(first!.firstChild!, 0, second!.querySelector('span')!.firstChild!, 5)
    const bold = screen.getByRole('button', { name: zh['block.bold'] })
    expect(bold.getAttribute('aria-pressed')).toBe('mixed')
    fireEvent.click(bold)
    expect(runsOf(first!)).toEqual([{ text: 'Hello', bold: true }])
    expect(runsOf(second!)).toEqual([{ text: 'World', bold: true }])
    fireEvent.keyDown(first!, { key: 'z', ctrlKey: true })
    expect(runsOf(first!)).toEqual([{ text: 'Hello' }])
    expect(runsOf(second!)).toEqual([{ text: 'World', bold: true }])
  })

  it('keeps a toolbar selection through menus and submits paragraph settings', () => {
    const editor = setup()
    const block = editor.paragraphs()[0]!
    editor.select(block.firstChild!, 0, block.firstChild!, 5)
    fireEvent.click(screen.getByRole('button', { name: zh['editor.paragraph'] }))
    fireEvent.change(screen.getByRole('combobox', { name: zh['editor.align'] }), { target: { value: 'center' } })
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-0', expect.objectContaining({ paragraphs: [expect.objectContaining({ format: { align: 'center' } })] }))
    expect(block.style.textAlign).toBe('center')
  })

  it('keeps complex paragraphs read-only and refuses cross-block text replacement', () => {
    const editor = setup('<p data-path="/body/p[1]">Hello</p><p data-path="/body/p[2]">World<img src="safe.png"></p>', ['Hello', 'World'])
    const [first, second] = editor.paragraphs()
    expect(first!.getAttribute('contenteditable')).toBe('true')
    expect(second!.getAttribute('contenteditable')).toBe('false')
    editor.select(first!.firstChild!, 0, second!.firstChild!, 5)
    fireEvent.paste(first!, { clipboardData: { getData: () => 'replacement' } })
    expect(first!.textContent).toBe('Hello')
    expect(second!.querySelector('img')).not.toBeNull()
    expect(editor.onDraft).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe(zh['editor.structureProtected'])
  })
})
