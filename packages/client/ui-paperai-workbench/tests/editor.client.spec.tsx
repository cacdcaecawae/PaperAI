// @vitest-environment jsdom
import { useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DocumentPreview } from '../src/client/DocumentPreview.tsx'
import { zh } from '../src/client/locales.ts'
import type { PaperAIBlockDraft, PaperAIBlockEdit, PaperAIDocumentNodeId, PaperAIDocumentSnapshot } from '../src/client/types.ts'
import type { PaperAIDocumentWorkbenchProps } from '../src/client/slots.ts'
import { readParagraphs } from '../src/client/editor-dom.ts'
import { runsOf } from '../src/client/preview-html.ts'
import { PaperAIWorkbenchController } from '../src/client/controller.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { commitFormatting } from '../src/client/format-intent.ts'
import {
  COMMIT_2, DOCUMENT_ID, NODE_HEADING, NODE_PARAGRAPH, RESOURCE_ID, REVISION_1, REVISION_2, SESSION_ID, WORKSPACE_ID,
  documentOpenResult, successfulRemote,
} from './fixtures.client.ts'

afterEach(cleanup)
// jsdom exposes InputEvent but does not implement the browser's target-range method.
Object.defineProperty(InputEvent.prototype, 'getTargetRanges', { configurable: true, value: () => [] })
const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}) as PaperAIDocumentWorkbenchProps['t']

/** Open one ribbon menu and pick a row by its label; a group name opens that paragraph submenu first. */
function pick(menu: string, label: string, group?: string): void {
  fireEvent.click(screen.getByRole('button', { name: menu }))
  if (group !== undefined) act(() => { screen.getByRole('menuitem', { name: group }).focus() })
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

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
  it.each(['external head', 'deferred preview', 'forced projection'] as const)('retains IME input when an %s arrives', async (arrival) => {
    const remote = successfulRemote()
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    const rendered = Promise.withResolvers<RemoteResult<ReturnType<typeof documentOpenResult>>>()
    remote.open = vi.fn<typeof remote.open>().mockReturnValue(rendered.promise)
    if (arrival === 'deferred preview') {
      remote.commit = vi.fn<typeof remote.commit>().mockResolvedValue({ ok: true,
        value: { createdCommitId: COMMIT_2, ...documentOpenResult(REVISION_2, { previewHtml: '' }) },
      })
      controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Committed heading' })
      await controller.commitEdit(SESSION_ID)
    }
    const store = controller.workbenchStore(SESSION_ID)
    function Live() {
      const state = useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())
      return <DocumentPreview html={state.document!.previewHtml} revision={state.document!.revision} nodes={state.document!.nodes}
        paragraphStyles={state.document!.paragraphStyles} title="Document" edits={state.edits} saving={false}
        busy={state.action !== null} t={t} onSave={() => {}} onCancel={() => {}}
        onComposing={(active) => { controller.setComposing(SESSION_ID, active) }}
        onDraft={(id, draft) => { controller.updateDraft(SESSION_ID, id, draft) }} />
    }
    const view = render(<Live />)
    const shadow = view.container.querySelector('[role="document"]')!.shadowRoot!
    const block = shadow.querySelector<HTMLElement>('p[data-paperai-node]')!
    let range = document.createRange()
    range.selectNodeContents(block); range.collapse(false)
    Object.defineProperty(shadow, 'getSelection', { value: () => ({ rangeCount: 1, getRangeAt: () => range,
      removeAllRanges: () => {}, addRange: (next: Range) => { range = next },
    }) })
    act(() => { block.focus() })
    fireEvent.compositionStart(block)
    block.textContent = 'Research background 中文输入'
    fireEvent.input(block, { isComposing: true, inputType: 'insertCompositionText' })
    await act(async () => {
      if (arrival === 'external head') controller.handleDocumentChanged({
        documentId: DOCUMENT_ID, headCommitId: COMMIT_2, updatedAt: '2026-09-26T00:00:00Z',
      })
      else if (arrival === 'deferred preview') rendered.resolve({ ok: true, value: documentOpenResult(REVISION_2) })
      else store.update((state) => {
        state.document = documentOpenResult(REVISION_2, {
          previewHtml: '<h1 data-path="/body/p[1]">Introduction</h1>',
          nodes: documentOpenResult().document.nodes.filter(node => node.nodeId === NODE_HEADING),
        }).document
      })
    })
    if (arrival === 'forced projection') {
      expect(block.isConnected).toBe(false)
      expect(store.getSnapshot().edits).toMatchObject([{ nodeId: NODE_PARAGRAPH, draft: 'Research background 中文输入',
        baseText: 'Research background', baseRevision: REVISION_1, conflicted: true }])
      expect(shadow.querySelector('.paperai-conflict-text')?.textContent).toBe('Research background 中文输入')
      const heading = shadow.querySelector<HTMLElement>('h1')!
      fireEvent.compositionEnd(heading)
      range.selectNodeContents(heading); range.collapse(false)
      act(() => { heading.focus() })
      fireEvent.compositionStart(heading)
      heading.textContent = 'Introduction 下一句'
      fireEvent.input(heading, { isComposing: true })
      fireEvent.compositionEnd(heading)
      expect(store.getSnapshot().edits).toMatchObject([
        { nodeId: NODE_PARAGRAPH, conflicted: true }, { nodeId: NODE_HEADING, draft: 'Introduction 下一句', baseRevision: REVISION_2 },
      ])
      fireEvent.keyDown(heading, { key: 'z', ctrlKey: true })
      expect(heading.textContent).toBe('Introduction')
      view.unmount()
      controller.dispose()
      return
    }
    expect(shadow.querySelector('p[data-paperai-node]')).toBe(block)
    expect(block.textContent).toBe('Research background 中文输入')
    expect(store.getSnapshot().edits).toEqual([])
    fireEvent.compositionEnd(block)
    expect(store.getSnapshot().edits).toMatchObject([{ nodeId: NODE_PARAGRAPH, draft: 'Research background 中文输入' }])
    expect(remote.open).toHaveBeenCalledTimes(arrival === 'external head' ? 0 : 1)
    fireEvent.keyDown(block, { key: 'z', ctrlKey: true })
    expect(block.textContent).toBe('Research background')
    view.unmount()
    controller.dispose()
  })

  it('keeps comparison text selectable without quoting it as the current document', () => {
    const onQuote = vi.fn()
    const html = '<p data-path="/body/p[1]">Unchanged</p><p data-path="/body/p[2]"><del>Old</del><ins>New</ins></p>'
    const props = { html, revision: REVISION_1, nodes: [
      { nodeId: NODE_HEADING, text: 'Unchanged', label: 'Unchanged', kind: 'paragraph' as const, depth: 0, editable: true },
    ], paragraphStyles: [], title: 'Document', edits: [], saving: false, t, onSave: vi.fn(), onCancel: vi.fn(), onDraft: vi.fn(), onQuote }
    const view = render(<DocumentPreview {...props} />)
    const shadow = view.container.querySelector('[role="document"]')!.shadowRoot!
    const block = shadow.querySelector('p')!
    const range = document.createRange()
    range.selectNodeContents(block)
    Object.defineProperty(shadow, 'getSelection', { value: () => ({ rangeCount: 1, getRangeAt: () => range }) })
    expect(fireEvent.contextMenu(block)).toBe(false)
    expect(screen.getByRole('menuitem', { name: zh['selection.ask'] })).toBeDefined()
    view.rerender(<DocumentPreview {...props} comparing />)
    expect(screen.queryByRole('menuitem', { name: zh['selection.ask'] })).toBeNull()
    range.setEndAfter(shadow.querySelector('ins')!)
    expect(fireEvent.contextMenu(block)).toBe(true)
    expect(range.toString()).toBe('UnchangedOldNew')
    expect(onQuote).not.toHaveBeenCalled()
    view.rerender(<DocumentPreview {...props} />)
    expect(screen.queryByRole('menuitem', { name: zh['selection.ask'] })).toBeNull()
  })

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
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-1', expect.objectContaining({ text: 'Wor中文ld' }))
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
    expect(editor.onDraft).toHaveBeenLastCalledWith(backward ? 'node-1' : 'node-0', expect.objectContaining({ text: 'Interior edit' }))
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
    pick(zh['editor.size'], '18')
    expect(store.getSnapshot().edits.find(edit => edit.nodeId === NODE_PARAGRAPH)?.runs)
      .toEqual([{ text: 'Changed paragraph', bold: true, size: '18pt' }])
    expect(runsOf(second!)).toEqual([{ text: 'Changed paragraph', bold: true, size: '18pt' }])
    expect(first!.contains(range.startContainer)).toBe(true)
    expect(second!.contains(range.endContainer)).toBe(true)
    expect(range.toString()).toBe('Changed headingChanged paragraph')
    pick(zh['editor.paragraph'], zh['editor.center'], zh['editor.align'])
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

  it.each(['mine', 'theirs'] as const)('requires a %s choice for externally reformatted plain and split drafts', async (choice) => {
    const NODE_CLOSING = 'node-closing' as PaperAIDocumentNodeId
    const page = (size: string): string => '<html><body>'
      + `<p data-path="/body/p[1]" style="font-size:10pt"><span style="font-size:${size}">Research</span>`
      + `<span style="font-size:${size};font-weight:bold;font-family:Times New Roman"> background</span></p>`
      + `<p data-path="/body/p[2]" style="font-size:10pt"><span style="font-size:${size}">Closing remarks</span></p></body></html>`
    const remote = successfulRemote()
    const commit = vi.spyOn(remote, 'commit')
    let opens = 0
    remote.open = vi.fn<typeof remote.open>(async () => {
      opens += 1
      return { ok: true, value: documentOpenResult(opens > 1 ? REVISION_2 : REVISION_1, {
        previewHtml: page(opens > 1 ? '16pt' : '12pt'),
        nodes: [
          { nodeId: NODE_PARAGRAPH, kind: 'paragraph', label: 'Research background', depth: 0, editable: true, text: 'Research background' },
          { nodeId: NODE_CLOSING, kind: 'paragraph', label: 'Closing remarks', depth: 0, editable: true, text: 'Closing remarks' },
        ],
      }) }
    })
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    const store = controller.workbenchStore(SESSION_ID)
    function Live() {
      const state = useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())
      if (state.document === null) return null
      return <DocumentPreview html={state.document.previewHtml} revision={state.document.revision} nodes={state.document.nodes}
        paragraphStyles={state.document.paragraphStyles} title="Document" edits={state.edits} saving={false} t={t}
        onSave={() => {}} onCancel={() => {}}
        onResolveConflict={(id) => { controller.resolveConflict(SESSION_ID, id) }}
        onDraft={(id, draft) => { controller.updateDraft(SESSION_ID, id, draft) }} />
    }
    const view = render(<Live />)
    const shadow = view.container.querySelector('[role="document"]')!.shadowRoot!
    let current: Range | null = null
    Object.defineProperty(shadow, 'getSelection', { configurable: true, value: () => ({
      get rangeCount() { return current === null ? 0 : 1 },
      getRangeAt: () => current,
      removeAllRanges: () => { current = null },
      addRange: (range: Range) => { current = range },
    }) })
    const blocks = (): HTMLElement[] => [...shadow.querySelectorAll<HTMLElement>('[data-paperai-block]')]
    const caret = (index: number, offset: number): HTMLElement => {
      const block = blocks()[index]!
      const node = block.querySelector('span')?.firstChild ?? block.firstChild!
      const range = document.createRange()
      range.setStart(node, offset); range.collapse(true); current = range
      act(() => { block.focus(); fireEvent.keyUp(block, { key: 'Shift' }) })
      return block
    }
    const type = (index: number, text: string): void => {
      const block = caret(index, 0)
      const node = block.querySelector('span')?.firstChild ?? block.firstChild!
      node.nodeValue = `${text}${node.nodeValue!}`
      fireEvent.input(block)
      act(() => { block.blur() })
    }
    // One plain draft, and one that split its block into paragraphs.
    type(0, '前言')
    const closing = caret(1, 'Closing'.length)
    fireEvent.keyDown(closing, { key: 'Enter' })
    act(() => { closing.blur(); fireEvent.input(closing) })
    expect(store.getSnapshot().edits.map(edit => edit.runs?.[0]?.size ?? edit.paragraphs?.[0]?.runs?.[0]?.size)).toEqual(['12pt', '12pt'])
    const drafts = store.getSnapshot().edits
    act(() => { controller.handleDocumentChanged({ documentId: DOCUMENT_ID, headCommitId: COMMIT_2, updatedAt: '2026-09-21T00:00:00.000Z' }) })
    await act(async () => { await controller.reloadExternal(SESSION_ID) })
    expect(store.getSnapshot().edits).toEqual(drafts.map(edit => ({ ...edit, conflicted: true })))
    expect(blocks().map(block => runsOf(block)[0]?.size)).toEqual(['12pt', '12pt'])
    expect(blocks()[0]!.querySelectorAll('span')).toHaveLength(2)
    expect(runsOf(blocks()[0]!)[1]).toMatchObject({ text: ' background', bold: true, font: 'Times New Roman' })
    expect(blocks().every(block => block.getAttribute('contenteditable') === 'false')).toBe(true)
    expect(shadow.querySelectorAll('[data-paperai-conflict]')).toHaveLength(2)
    await act(async () => { expect((await controller.commitEdit(SESSION_ID)).ok).toBe(false) })
    expect(commit).not.toHaveBeenCalled()
    for (const button of shadow.querySelectorAll<HTMLElement>(`[data-paperai-resolve="${choice}"]`)) fireEvent.click(button)
    expect(shadow.querySelector('[data-paperai-conflict]')).toBeNull()
    expect(blocks().every(block => block.getAttribute('contenteditable') === 'true')).toBe(true)
    if (choice === 'mine') {
      expect(store.getSnapshot().edits.every(edit => edit.baseRevision === REVISION_2)).toBe(true)
      type(0, '再')
      type(1, '再')
      expect(shadow.querySelector('[data-paperai-conflict]')).toBeNull()
      await act(async () => { expect((await controller.commitEdit(SESSION_ID)).ok).toBe(true) })
      const mutations = commit.mock.calls[0]![0].mutations
      expect(mutations).toMatchObject([
        { nodeId: NODE_PARAGRAPH, nextText: '再前言Research background', runs: [{ text: '再前言Research background', size: '12pt' }] },
        { nodeId: NODE_CLOSING, nextText: '再Closing\n remarks', paragraphs: [
          { text: '再Closing', runs: [{ text: '再Closing', size: '12pt' }] },
          { text: ' remarks', runs: [{ text: ' remarks', size: '12pt' }] },
        ] },
      ])
    } else {
      expect(store.getSnapshot().edits).toEqual([])
      expect(runsOf(blocks()[0]!)).toMatchObject([
        { text: 'Research', size: '16pt' }, { text: ' background', size: '16pt', bold: true, font: 'Times New Roman' },
      ])
    }
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
    pick(zh['editor.font'], 'Times New Roman')
    pick(zh['editor.size'], '18')
    expect(runsOf(block)).toEqual([{ text: 'Hello world', font: 'Times New Roman', size: '18pt' }])
    expect(screen.getByRole('button', { name: zh['editor.font'] }).getAttribute('title')).toContain(zh['editor.explicit'])
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
    fireEvent.click(screen.getByRole('button', { name: zh['block.save'] }))
    expect(editor.onSave).toHaveBeenCalledTimes(3)
    fireEvent.keyDown(block, { key: 'Escape' })
    expect(runsOf(block)).toEqual([{ text: 'Hello world' }])
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-0', null)
  })

  it('submits paragraph style, spacing and indentation from the paragraph menu; the find field keeps its arrow keys', () => {
    const editor = setup()
    const block = editor.paragraphs()[0]!
    editor.select(block.firstChild!, 3)
    pick(zh['editor.paragraph'], '章节标题', zh['editor.style'])
    pick(zh['editor.paragraph'], '2x', zh['editor.spacing'])
    pick(zh['editor.paragraph'], '24 磅', zh['editor.indent'])
    expect(readParagraphs(block)[0]?.format).toEqual({ style: 'SectionTitle', lineSpacing: '2x', indent: '24pt' })
    expect(block.style.marginLeft).toBe('24pt')
    expect(block.style.lineHeight).toBe('2')
    // The menu marks the current reading inside its submenu.
    fireEvent.click(screen.getByRole('button', { name: zh['editor.paragraph'] }))
    act(() => { screen.getByRole('menuitem', { name: zh['editor.style'] }).focus() })
    expect(screen.getByRole('menuitem', { name: '章节标题' }).className).toContain('selected')
    expect(screen.getByRole('menuitem', { name: '正文' }).className).not.toContain('selected')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['editor.find'] }))
    const find = screen.getByRole('textbox', { name: zh['editor.findPlaceholder'] })
    expect(fireEvent.keyDown(find, { key: 'ArrowLeft' })).toBe(true)
    act(() => { find.focus() })
    fireEvent.keyDown(find, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh['editor.find'] }))
  })

  it.each([undefined, 'ImportedStyle'])('disables an empty style catalog while retaining the current reading %s', (style) => {
    const editor = setup('<p data-path="/body/p[1]">Hello world</p>', ['Hello world'], false, [])
    const block = editor.paragraphs()[0]!
    if (style !== undefined) block.dataset.paperaiFormat = JSON.stringify({ style })
    editor.select(block.firstChild!, 2)
    fireEvent.click(screen.getByRole('button', { name: zh['editor.paragraph'] }))
    const styles = screen.getByRole<HTMLButtonElement>('menuitem', { name: zh['editor.style'] })
    expect(styles.disabled).toBe(style === undefined)
    if (style !== undefined) {
      act(() => { styles.focus() })
      const current = screen.getByRole<HTMLButtonElement>('menuitem', { name: style })
      expect(current.disabled).toBe(true)
      expect(current.className).toContain('selected')
    }
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: zh['editor.align'] }).disabled).toBe(false)
    expect(screen.queryByRole('menuitem', { name: 'Heading1' })).toBeNull()
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

  it('counts the rendered pages in a pill and hides it when the preview has no pages', () => {
    const paged = setup('<div class="page"><p data-path="/body/p[1]">Hello world</p></div><div class="page"><p data-path="/body/p[2]">Second page</p></div>',
      ['Hello world', 'Second page'])
    expect(screen.getByLabelText(/第 \d \/ 2 页/).textContent).toMatch(/\/ 2$/)
    expect(paged.paragraphs()).toHaveLength(2)
    cleanup()
    setup()
    expect(screen.queryByLabelText(/页$/)).toBeNull()
  })

  it('brings the revealed block under the top edge of the page', () => {
    const body = '<p data-path="/body/p[1]">Hello world</p><p data-path="/body/p[2]">Second block</p>'
    const nodes = ['Hello world', 'Second block'].map((text, index) => ({
      nodeId: `node-${index}` as PaperAIDocumentNodeId, text, label: text, kind: 'paragraph' as const, depth: 0, editable: true,
    }))
    const shared = {
      html: body, revision: REVISION_1, nodes, title: 'Document', edits: [], saving: false, t, paragraphStyles: [],
      onDraft: vi.fn(), onSave: vi.fn(), onCancel: vi.fn(),
    }
    const view = render(<DocumentPreview {...shared} reveal={null} />)
    const host = view.container.querySelector<HTMLElement>('[role="document"]')!
    const second = host.shadowRoot!.querySelectorAll<HTMLElement>('[data-path]')[1]!
    second.getBoundingClientRect = () => ({ top: 300 } as DOMRect)
    view.rerender(<DocumentPreview {...shared} reveal={{ nodeId: 'node-1' as PaperAIDocumentNodeId, tick: 1 }} />)
    expect(host.scrollTop).toBe(284)
    view.rerender(<DocumentPreview {...shared} reveal={{ nodeId: 'node-1' as PaperAIDocumentNodeId, tick: 2 }} />)
    expect(host.scrollTop).toBe(568)
  })

  it('keeps the ribbon visible and displays inherited caret font and size', () => {
    const editor = setup()
    expect(screen.getByRole('toolbar', { name: zh['editor.ribbon'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['block.bold'] }).hasAttribute('disabled')).toBe(true)
    const block = editor.paragraphs()[0]!
    editor.select(block.firstChild!, 2)
    expect(screen.getByRole('button', { name: zh['editor.size'] }).textContent).toBe('12')
    expect(screen.getByRole('button', { name: zh['editor.font'] }).textContent).toBe('Arial')
    expect(screen.getByRole('button', { name: zh['editor.font'] }).title).toContain(zh['editor.insertion'])
    expect(editor.onDraft).not.toHaveBeenCalled()
    const bold = screen.getByRole('button', { name: zh['block.bold'] })
    act(() => { bold.focus() })
    expect(fireEvent.keyDown(bold, { key: 'Home' })).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh['editor.font'] }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh['editor.size'] }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
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
    pick(zh['editor.paragraph'], zh['editor.center'], zh['editor.align'])
    pick(zh['editor.paragraph'], '1.5x', zh['editor.spacing'])
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
    expect(screen.getByRole('button', { name: zh['editor.font'] }).textContent).toBe(zh['editor.font'])
    expect(screen.getByRole('button', { name: zh['editor.size'] }).textContent).toBe(zh['editor.size'])
    editor.select(block, 0, block, block.childNodes.length)
    fireEvent.click(screen.getByRole('button', { name: zh['editor.clear'] }))
    expect(screen.getByRole('button', { name: zh['editor.font'] }).textContent).toBe(zh['editor.inherited'])
    expect(screen.getByRole('button', { name: zh['editor.font'] }).hasAttribute('data-muted')).toBe(true)
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
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-0', expect.objectContaining({ text: 'Hello中文 world' }))
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
    pick(zh['editor.paragraph'], zh['editor.center'], zh['editor.align'])
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

/**
 * One conflicted paragraph, rendered the way the workbench renders it after an external reload: the page
 * holds the document's new text, the store holds the writer's draft, and the edit is marked conflicted.
 * @param body - the reloaded page.
 * @param texts - what each node reads in the document now.
 * @param draft - the writer's unsaved text for the conflicted node.
 * @param conflictedIndex - which node is in conflict.
 * @returns the shadow root, the spies, and the band's buttons.
 */
function conflicted(body: string, texts: readonly string[], draft: string, conflictedIndex = 0,
  kind: 'paragraph' | 'table-cell' = 'paragraph') {
  const onDraft = vi.fn()
  const onResolveConflict = vi.fn()
  const nodes = texts.map((text, index) => ({
    nodeId: `node-${index}` as PaperAIDocumentNodeId, text, label: text, kind, depth: 0, editable: true,
  }))
  const subject = nodes[conflictedIndex]!.nodeId
  function Harness() {
    const [edits, setEdits] = useState<PaperAIBlockEdit[]>([
      { nodeId: subject, baseText: 'stale base', draft, conflicted: true },
    ])
    return <DocumentPreview html={body} revision={REVISION_1} nodes={nodes} title="Document" edits={edits} saving={false} t={t}
      onSave={vi.fn()} paragraphStyles={[]} onCancel={() => { setEdits([]) }}
      // The controller's own shape: the rebase clears the flag and leaves the draft alone.
      onResolveConflict={(nodeId) => {
        onResolveConflict(nodeId)
        setEdits(current => current.map(edit => (edit.nodeId === nodeId
          ? { ...edit, baseText: nodes.find(node => node.nodeId === nodeId)?.text ?? '', conflicted: false }
          : edit)))
      }}
      onDraft={(nodeId, next) => {
        onDraft(nodeId, next)
        setEdits(current => [...current.filter(edit => edit.nodeId !== nodeId), ...(next === null ? [] : [{
          ...current.find(edit => edit.nodeId === nodeId),
          nodeId, baseText: current.find(edit => edit.nodeId === nodeId)?.baseText ?? '', draft: next.text,
          ...(next.runs === undefined ? {} : { runs: next.runs }),
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
  return {
    shadow, onDraft, onResolveConflict,
    getRange: () => current,
    band: () => shadow.querySelector<HTMLElement>('[data-paperai-conflict]'),
    act: (resolve: string) => shadow.querySelector<HTMLElement>(`[data-paperai-resolve="${resolve}"]`),
    blocks: () => [...shadow.querySelectorAll<HTMLElement>('[data-paperai-block]')],
  }
}

describe('Conflict resolution in the page', () => {
  const PAGE = '<p data-path="/body/p[1]">文档改写后的这一段</p>'

  it('quotes the document above the paragraph and marks what each side contributed', () => {
    const editor = conflicted(PAGE, ['文档改写后的这一段'], '文档保留原样的这一段')
    const band = editor.band()!
    // The band stands immediately before the paragraph it contests, inside the page.
    expect(band.nextElementSibling).toBe(editor.blocks()[0])
    expect(band.getAttribute('contenteditable')).toBe('false')
    expect(band.dataset.paperaiConflictForm).toBe('document')
    expect(band.querySelector('.paperai-conflict-who')!.textContent).toBe(zh['editor.conflictTheirs'])
    // Both marks present, and the legend names them in words so neither depends on hue.
    expect(band.querySelectorAll('del').length).toBeGreaterThan(0)
    expect(band.querySelectorAll('ins').length).toBeGreaterThan(0)
    expect(band.querySelector('.paperai-conflict-legend')!.textContent).toBe(zh['editor.conflictLegend'])
    // The two halves of one object: solid beside the document's text, dashed beside the draft.
    expect(editor.blocks()[0]!.dataset.paperaiConflictSeat).toBe('mine')
    // The paragraph shows the writer's draft and is frozen until they choose.
    expect(editor.blocks()[0]!.textContent).toBe('文档保留原样的这一段')
    expect(editor.blocks()[0]!.getAttribute('contenteditable')).toBe('false')
  })

  it('thaws the paragraph on 用我的 so the merge is typed in the page', () => {
    const editor = conflicted(PAGE, ['文档改写后的这一段'], '文档保留原样的这一段')
    expect(editor.blocks()[0]!.getAttribute('contenteditable')).toBe('false')
    fireEvent.click(editor.act('mine')!)
    expect(editor.onResolveConflict).toHaveBeenCalledWith('node-0')
    const block = editor.blocks()[0]!
    // The whole point: the same caret, IME and ribbon that write every other paragraph now write this one.
    expect(block.getAttribute('contenteditable')).toBe('true')
    // And the band goes, because there is no longer a decision waiting.
    expect(editor.band()).toBeNull()
    expect(block.dataset.paperaiConflictSeat).toBeUndefined()
    // The repaint wraps the draft in a run, so reach the text itself rather than the block's first child.
    const text = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode()!
    text.nodeValue = `${text.nodeValue!}续写`
    fireEvent.input(block)
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-0', expect.objectContaining({ text: '文档保留原样的这一段续写' }))
  })

  it('takes the document on 用文档的 and keeps the draft one undo away', () => {
    const editor = conflicted(PAGE, ['文档改写后的这一段'], '文档保留原样的这一段')
    fireEvent.click(editor.act('theirs')!)
    expect(editor.onResolveConflict).not.toHaveBeenCalled()
    // The edit drops itself: the block now reads exactly what the document delivered.
    expect(editor.blocks()[0]!.textContent).toBe('文档改写后的这一段')
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-0', null)
    expect(editor.band()).toBeNull()
    // A press that destroys a draft must be recoverable, which is why it routes through history.
    fireEvent.click(screen.getByRole('button', { name: zh['editor.undo'] }))
    expect(editor.blocks()[0]!.textContent).toBe('文档保留原样的这一段')
    expect(editor.onDraft).toHaveBeenLastCalledWith('node-0', expect.objectContaining({ text: '文档保留原样的这一段' }))
  })

  it('clears the gutter rule on a paragraph whose band had to stand before its table', () => {
    // A band never enters a table, so for a cell it seats before the whole table — which means its next
    // sibling is the table, not the paragraph, and finding the seat that way would strand this rule.
    const editor = conflicted('<table><tr><td><p data-path="/body/tbl[1]/tr[1]/td[1]/p[1]">文档改写后的这一段</p></td></tr></table>',
      ['文档改写后的这一段'], '文档保留原样的这一段', 0, 'table-cell')
    const band = editor.band()!
    expect(band.nextElementSibling?.tagName).toBe('TABLE')
    expect(editor.blocks()[0]!.dataset.paperaiConflictSeat).toBe('mine')
    fireEvent.click(editor.act('mine')!)
    expect(editor.band()).toBeNull()
    expect(editor.blocks()[0]!.dataset.paperaiConflictSeat).toBeUndefined()
  })

  it('drops the marking when the document rewrote the paragraph outright', () => {
    // Almost nothing survives, so per-character Han runs would stipple rather than mark.
    const editor = conflicted('<p data-path="/body/p[1]">近年来大模型在文本生成方面进展显著</p>',
      ['近年来大模型在文本生成方面进展显著'], '本课题旨在构建面向学位论文的写作工作台')
    const band = editor.band()!
    expect(band.querySelectorAll('del, ins').length).toBe(0)
    expect(band.querySelector('.paperai-conflict-text')!.textContent).toBe('近年来大模型在文本生成方面进展显著')
    expect(band.querySelector('.paperai-conflict-legend')!.textContent).toBe(zh['editor.conflictRewritten'])
  })
})

describe('Conflict on a paragraph the browser cannot merge', () => {
  // A citation superscript is exactly what an Agent adds and what COMPLEX excludes from `mapping`.
  const PAGE = '<p data-path="/body/p[1]">文档改写后的这一段<sup>[1]</sup></p>'

  it('keeps a deleted paragraph draft visible, copyable and separately discardable', async () => {
    const remote = successfulRemote()
    const controller = new PaperAIWorkbenchController(remote)
    await controller.openDocument(WORKSPACE_ID, SESSION_ID, RESOURCE_ID)
    const store = controller.workbenchStore(SESSION_ID)
    controller.updateDraft(SESSION_ID, NODE_PARAGRAPH, { text: 'Deleted paragraph draft' })
    controller.updateDraft(SESSION_ID, NODE_HEADING, { text: 'Unrelated draft' })
    remote.open = vi.fn<typeof remote.open>().mockResolvedValue({ ok: true, value: documentOpenResult(REVISION_2, {
      previewHtml: '<div><div class="page"><p data-path="/body/p[1]">Introduction</p></div></div>',
      nodes: documentOpenResult().document.nodes.filter(node => node.nodeId === NODE_HEADING),
    }) })
    controller.handleDocumentChanged({ documentId: DOCUMENT_ID, headCommitId: COMMIT_2, updatedAt: '2026-09-21T00:00:00.000Z' })
    await controller.reloadExternal(SESSION_ID)
    function Live() {
      const state = useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())
      return <DocumentPreview html={state.document!.previewHtml} revision={state.document!.revision} nodes={state.document!.nodes}
        paragraphStyles={[]} title="Document" edits={state.edits} saving={false} t={t}
        onSave={() => {}} onCancel={() => {}} onDraft={(id, draft) => { controller.updateDraft(SESSION_ID, id, draft) }} />
    }
    const view = render(<Live />)
    const shadow = view.container.querySelector('[role="document"]')!.shadowRoot!
    let selected: Range | null = null
    Object.defineProperty(shadow, 'getSelection', { value: () => ({
      removeAllRanges: () => { selected = null }, addRange: (range: Range) => { selected = range },
    }) })
    const band = shadow.querySelector<HTMLElement>('[data-paperai-conflict]')!
    expect(band.parentElement).toBe(shadow.querySelector('.paperai-doc'))
    expect(band.nextElementSibling?.querySelector('.page')).toBe(shadow.querySelector('.page'))
    expect(band.dataset.paperaiConflictForm).toBe('draft')
    expect(band.querySelector('.paperai-conflict-text')!.textContent).toBe('Deleted paragraph draft')
    expect(band.querySelector('[data-paperai-resolve="mine"]')).toBeNull()
    fireEvent.click(band.querySelector('[data-paperai-resolve="copy"]')!)
    expect((selected as Range | null)?.toString()).toBe('Deleted paragraph draft')
    const drop = band.querySelector('[data-paperai-resolve="drop"]')!
    fireEvent.click(drop)
    expect(store.getSnapshot().edits).toHaveLength(2)
    fireEvent.click(drop)
    expect(store.getSnapshot().edits).toMatchObject([{ nodeId: NODE_HEADING, draft: 'Unrelated draft' }])
    expect(shadow.querySelector('[data-paperai-conflict]')).toBeNull()
    controller.dispose()
  })

  it('quotes the draft for saving by hand instead of promising a merge it cannot deliver', () => {
    const editor = conflicted(PAGE, ['文档改写后的这一段[1]'], '文档保留原样的这一段')
    const band = editor.band()!
    expect(band.dataset.paperaiConflictForm).toBe('draft')
    expect(band.querySelector('.paperai-conflict-who')!.textContent).toBe(zh['editor.conflictMine'])
    expect(band.querySelector('.paperai-conflict-legend')!.textContent).toBe(zh['editor.conflictUnmergeable'])
    // The draft verbatim, unmarked: there is nothing to choose between, only something to rescue.
    expect(band.querySelector('.paperai-conflict-text')!.textContent).toBe('文档保留原样的这一段')
    expect(band.querySelectorAll('del, ins').length).toBe(0)
    // No 用我的, because no keystroke can land in that paragraph.
    expect(editor.act('mine')).toBeNull()
    expect(editor.act('copy')).not.toBeNull()
    expect(editor.act('drop')).not.toBeNull()
    // Its seat wears the solid rule: the paragraph is showing the document, the band the draft.
    expect(band.nextElementSibling).toBe(editor.shadow.querySelector('[data-paperai-node="node-0"]'))
    expect(editor.shadow.querySelector<HTMLElement>('[data-paperai-node="node-0"]')!.dataset.paperaiConflictSeat).toBe('theirs')
  })

  it('selects the quoted draft on 复制草稿 so a refused clipboard still leaves Ctrl+C working', () => {
    const editor = conflicted(PAGE, ['文档改写后的这一段[1]'], '文档保留原样的这一段')
    fireEvent.click(editor.act('copy')!)
    expect(editor.getRange()!.toString()).toBe('文档保留原样的这一段')
    expect(editor.onDraft).not.toHaveBeenCalled()
  })

  it('asks twice before discarding a draft that exists nowhere else', () => {
    const editor = conflicted(PAGE, ['文档改写后的这一段[1]'], '文档保留原样的这一段')
    const drop = editor.act('drop')!
    fireEvent.click(drop)
    expect(editor.onDraft).not.toHaveBeenCalled()
    expect(drop.textContent).toBe(zh['editor.conflictDropConfirm'])
    // A click anywhere else puts the question back, so a stray second click cannot complete it.
    fireEvent.click(editor.shadow.querySelector('.paperai-doc')!)
    expect(drop.textContent).toBe(zh['editor.conflictDrop'])
    fireEvent.click(drop)
    expect(editor.onDraft).not.toHaveBeenCalled()
    fireEvent.click(drop)
    expect(editor.onDraft).toHaveBeenCalledWith('node-0', null)
    expect(editor.band()).toBeNull()
  })
})
