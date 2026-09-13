/** Editable Host preview with temporary block drafts, document commands, and local undo history. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaperAIBlockDraft, PaperAIBlockEdit, PaperAIDocumentNodeId, PaperAIDocumentNodeSummary, PaperAIDocumentSnapshot, PaperAIDocumentTextRun, PaperAIParagraphFormat } from './types.ts'
import type { PaperAIDocumentWorkbenchProps } from './slots.ts'
import css from './DocumentWorkbench.module.css'
import { applyParagraphs, applyRuns, blocksOf, fontOf, normalize, paragraphsOf, restateCleared, runsOf, sameRuns, textOf } from './preview-html.ts'
import { formatParagraphs, formatRange, insertParagraphText, readParagraphs, selectedParagraphs, selectionReading } from './editor-dom.ts'
import { EditorRibbon, type EditorFormat } from './EditorRibbon.tsx'
import type { WordExcerpt } from './selection-context.ts'

/** Editable document projection and commands owned by the workbench. */
export interface DocumentPreviewProps {
  readonly active?: boolean
  readonly scrollTop?: number
  readonly zoom?: number | 'fit'
  readonly onScroll?: (scrollTop: number) => void
  readonly onQuote?: (excerpt: WordExcerpt) => void
  readonly html: string
  readonly revision: PaperAIDocumentSnapshot['revision']
  readonly nodes: readonly PaperAIDocumentNodeSummary[]
  readonly paragraphStyles: PaperAIDocumentSnapshot['paragraphStyles']
  readonly title: string
  readonly edits: readonly PaperAIBlockEdit[]
  readonly comparing?: boolean
  readonly saving: boolean
  readonly busy?: boolean
  readonly onDraft: (nodeId: PaperAIDocumentNodeId, draft: PaperAIBlockDraft | null) => void
  readonly onSave: () => void
  readonly onCancel: () => void
  readonly t: PaperAIDocumentWorkbenchProps['t']
}

const DROPPED_ELEMENTS = 'script, iframe, object, embed, link, meta, base, form, input, button, textarea, select, noscript'
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction'])
const COMPLEX = 'img, svg, math, canvas, video, audio, a, table, [data-field], [data-formula], .katex-formula, .equation, .math, .field, sup, sub'
const PREVIEW_STYLE = `
:host { display: block; }
.paperai-doc { width: fit-content; margin: 0 auto; color: var(--dsw-static-neutral-1000); zoom: var(--paperai-page-zoom, 1); }
.paperai-doc .page { outline: 1px solid var(--dsw-alias-border-l2); }
[data-paperai-change], [data-paperai-changed] { position: relative; }
[data-paperai-change]::before, [data-paperai-changed]::before { content: '✎'; position: absolute; left: -20px; top: 0; font: 12px sans-serif; color: var(--dsw-alias-state-business-primary); }
[data-paperai-conflicted]::before { content: '!'; font-weight: bold; color: var(--dsw-alias-state-error-primary); }
[data-paperai-conflicted] { border-inline-start: 2px dashed var(--dsw-alias-state-error-primary); }
[data-paperai-change][data-paperai-current] { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
[data-paperai-change] del { background: var(--dsw-alias-state-error-tertiary); color: var(--dsw-alias-state-error-primary); text-decoration: line-through; }
[data-paperai-change] ins { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); text-decoration: underline; }
[data-paperai-block][contenteditable="true"] { cursor: text; outline: none; min-height: 1em; caret-color: var(--dsw-alias-state-business-primary); }
[data-paperai-paragraph] { display: block; min-height: 1em; }
`

function sanitize(html: string): { readonly styles: string; readonly body: Node[] } {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  for (const element of parsed.querySelectorAll(DROPPED_ELEMENTS)) element.remove()
  for (const element of parsed.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const raster = element.tagName === 'IMG' && name === 'src' && /^\s*data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,/iu.test(attribute.value)
      const scripted = URL_ATTRIBUTES.has(name) && /^\s*(?:javascript|data):/iu.test(attribute.value) && !raster
      if (name.startsWith('on') || scripted || name === 'contenteditable'
        || (name.startsWith('data-paperai-') && name !== 'data-paperai-change')) element.removeAttribute(attribute.name)
    }
  }
  const styles = [...parsed.querySelectorAll('style')].map(style => style.textContent).join('\n')
  for (const style of parsed.querySelectorAll('style')) style.remove()
  return { styles, body: [...parsed.body.childNodes].map(node => document.importNode(node, true)) }
}

/** Addressed body blocks consume equal-text nodes in reading order; page bands never enter this mapping. */
function mapBlocks(blocks: readonly HTMLElement[], nodes: readonly PaperAIDocumentNodeSummary[]): Map<HTMLElement, PaperAIDocumentNodeId> {
  const used = new Set<PaperAIDocumentNodeId>()
  const mapping = new Map<HTMLElement, PaperAIDocumentNodeId>()
  for (const block of blocks) {
    if (!block.dataset.path) continue
    const cell = block.closest('td, th') !== null
    const node = nodes.find(candidate => candidate.kind !== 'table' && !used.has(candidate.nodeId)
      && (candidate.kind === 'table-cell') === cell && normalize(candidate.text) === normalize(textOf(block)))
    if (node === undefined) continue
    used.add(node.nodeId)
    if (node.editable && block.querySelector(COMPLEX) === null) mapping.set(block, node.nodeId)
    else block.dataset.paperaiProtected = ''
  }
  return mapping
}

interface BlockImage {
  readonly block: HTMLElement
  readonly html: string
  readonly style: string | null
  readonly format: string | undefined
  readonly parent: Node | null
  readonly next: Node | null
}
interface HistoryEntry { readonly before: readonly BlockImage[]; readonly after: readonly BlockImage[] }
function imageOf(block: HTMLElement): BlockImage {
  return { block, html: block.innerHTML, style: block.getAttribute('style'), format: block.dataset.paperaiFormat,
    parent: block.parentNode, next: block.nextSibling }
}
function sameImage(left: BlockImage, right: BlockImage): boolean {
  return left.html === right.html && left.style === right.style && left.format === right.format
}
function restoreImage(image: BlockImage): void {
  if (image.parent !== null && image.block.parentNode !== image.parent) {
    image.parent.insertBefore(image.block, image.next?.parentNode === image.parent ? image.next : null)
  }
  image.block.innerHTML = image.html
  if (image.style === null) image.block.removeAttribute('style')
  else image.block.setAttribute('style', image.style)
  if (image.format === undefined) delete image.block.dataset.paperaiFormat
  else image.block.dataset.paperaiFormat = image.format
}

/** Restore rejected, non-cancelable composition without replacing mapped node identities. */
function compositionSnapshot(container: HTMLElement): () => void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ALL)
  const nodes: Node[] = [container]
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node)
  const images = nodes.map(node => ({ node, value: node.nodeValue, children: [...node.childNodes],
    attributes: node instanceof Element ? [...node.attributes].map(attribute => [attribute.name, attribute.value] as const) : [],
  }))
  return () => {
    for (const { node, value, children, attributes } of images) {
      if (node instanceof Element) {
        node.replaceChildren(...children)
        for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name)
        for (const [name, text] of attributes) node.setAttribute(name, text)
      }
      else node.nodeValue = value
    }
  }
}

/** Render draft operations over the preview; successful Host commits replace the document revision. */
export function DocumentPreview({ html, revision, nodes, paragraphStyles, title, edits, saving, onDraft, onSave, onCancel, t,
  active = true, scrollTop = 0, zoom = 'fit', onScroll, onQuote, comparing = false, busy = false,
}: DocumentPreviewProps): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const mapping = useRef(new Map<HTMLElement, PaperAIDocumentNodeId>())
  const originals = useRef(new Map<HTMLElement, { image: BlockImage; runs: readonly PaperAIDocumentTextRun[] }>())
  const latest = useRef(new Map<HTMLElement, BlockImage>())
  const history = useRef<{ past: HistoryEntry[]; future: HistoryEntry[] }>({ past: [], future: [] })
  const publishing = useRef(false)
  const composing = useRef(false)
  const compositionBlock = useRef<HTMLElement | null>(null)
  const blockedComposition = useRef<(() => void) | null>(null)
  const target = useRef<{ range: Range; blocks: HTMLElement[] } | null>(null)
  const findCursor = useRef<{ query: string; block: HTMLElement; offset: number } | null>(null)
  const callbacks = useRef({ onDraft, onSave })
  callbacks.current = { onDraft, onSave }
  const [caret, setCaret] = useState<EditorFormat | null>(null)
  const [excerpt, setExcerpt] = useState<WordExcerpt | null>(null)
  const [historyState, setHistoryState] = useState({ undo: false, redo: false })
  const [notice, setNotice] = useState<'editor.protected' | 'editor.conflict' | 'editor.structureProtected' | null>(null)
  const [changes, setChanges] = useState({ count: 0, index: 0 })
  const [fonts, setFonts] = useState<readonly string[]>([])
  const conflicted = edits.some(edit => edit.conflicted === true)
  const editable = !comparing && !saving && !busy && !conflicted

  const selection = (): Selection | null =>
    (host.current?.shadowRoot as (ShadowRoot & { getSelection?: () => Selection | null }) | null)?.getSelection?.() ?? window.getSelection()
  const rangeNow = (): Range | null => {
    const current = selection()
    return current === null || current.rangeCount === 0 ? null : current.getRangeAt(0)
  }
  const capture = (range = rangeNow()): void => {
    if (range === null) return
    const blocks = [...mapping.current.keys()].filter(block =>
      range.collapsed ? block.contains(range.startContainer) : range.intersectsNode(block))
    if (blocks.length === 0) {
      if (host.current?.shadowRoot?.contains(range.startContainer) === true) {
        target.current = null
        setCaret(null)
        setExcerpt(null)
      }
      return
    }
    target.current = { range: range.cloneRange(), blocks }
    setCaret(editable ? selectionReading(range, blocks) : null)
    setExcerpt(range.collapsed || range.toString().trim() === '' ? null : {
      nodeIds: blocks.flatMap((block) => {
        const id = mapping.current.get(block)
        return id === undefined ? [] : [id]
      }), text: range.toString(),
    })
  }
  const select = (range: Range): void => {
    const current = selection()
    current?.removeAllRanges(); current?.addRange(range); capture(range)
  }
  const updateHistory = (): void =>{  setHistoryState({ undo: history.current.past.length > 0, redo: history.current.future.length > 0 }) }

  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' })
    const content = sanitize(html)
    const style = document.createElement('style')
    style.textContent = `${content.styles}\n${PREVIEW_STYLE}`
    const container = document.createElement('div')
    container.className = 'paperai-doc'; container.append(...content.body)
    const blocks = blocksOf(container)
    blocks.forEach((block, index) => { block.dataset.paperaiBlock = String(index) })
    mapping.current = mapBlocks(blocks, nodes)
    for (const element of container.querySelectorAll<HTMLElement>('*')) {
      if (element.closest('[data-paperai-protected]') !== null) continue
      if (![...mapping.current.keys()].some(block => block.contains(element) || element.contains(block))) element.dataset.paperaiProtected = ''
    }
    shadow.replaceChildren(style, container)
    originals.current = new Map([...mapping.current.keys()].map(block => [block, { image: imageOf(block), runs: runsOf(block) }]))
    latest.current = new Map([...mapping.current.keys()].map(block => [block, imageOf(block)]))
    history.current = { past: [], future: [] }; updateHistory(); target.current = null
    setCaret(null); setExcerpt(null)
    setFonts([...new Set([...mapping.current.keys()].flatMap(block => [block, ...block.querySelectorAll<HTMLElement>('span')])
      .map(block => fontOf(getComputedStyle(block))).filter(Boolean).concat(['宋体', '黑体', '等线', 'Times New Roman', 'Arial']))])
    setChanges({ count: container.querySelectorAll('[data-paperai-change]').length, index: 0 })
  }, [html, revision])

  useLayoutEffect(() => {
    const drafts = new Map(edits.map(edit => [edit.nodeId, edit]))
    const shadow = host.current?.shadowRoot
    const container = shadow?.querySelector<HTMLElement>('.paperai-doc')
    if (editable) container?.setAttribute('contenteditable', 'true')
    else container?.removeAttribute('contenteditable')
    for (const block of shadow?.querySelectorAll<HTMLElement>('[data-paperai-block], [data-paperai-protected]') ?? []) {
      if (editable) block.setAttribute('contenteditable', mapping.current.has(block) ? 'true' : 'false')
      else block.removeAttribute('contenteditable')
    }
    const focused = shadow?.activeElement
    const focusNode = focused === container ? rangeNow()?.startContainer : focused
    for (const [block, nodeId] of mapping.current) {
      const edit = drafts.get(nodeId)
      const original = originals.current.get(block)
      if (!block.contains(focusNode ?? null) && !publishing.current) {
        if (edit?.paragraphs !== undefined && JSON.stringify(readParagraphs(block)) !== JSON.stringify(edit.paragraphs)) {
          applyParagraphs(block, edit.paragraphs)
        }
        else if (edit?.runs !== undefined && !sameRuns(runsOf(block), edit.runs)) applyRuns(block, edit.runs)
        else if (edit !== undefined && edit.paragraphs === undefined && textOf(block) !== edit.draft) {
          applyRuns(block, [{ text: edit.draft }])
        }
        else if (edit === undefined && original !== undefined && block.hasAttribute('data-paperai-changed')) restoreImage(original.image)
      }
      block.toggleAttribute('data-paperai-changed', edit !== undefined)
      block.toggleAttribute('data-paperai-conflicted', edit?.conflicted === true)
      latest.current.set(block, imageOf(block))
    }
    if (conflicted) { setCaret(null); setNotice('editor.conflict') }
  }, [edits, editable, html, nodes])
  useLayoutEffect(() => { if (active && host.current !== null) host.current.scrollTop = scrollTop }, [active, html])
  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    const fit = (): void => {
      const pages = element.shadowRoot?.querySelector<HTMLElement>('.paperai-doc')
      if (pages === undefined || pages === null) return
      const old = parseFloat(element.style.getPropertyValue('--paperai-page-zoom')) || 1
      const position = element.scrollTop / old
      element.style.setProperty('--paperai-page-zoom', '1')
      const style = getComputedStyle(element)
      const available = element.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
      const natural = pages.offsetWidth
      const factor = zoom === 'fit' ? natural > 0 && available > 0 ? Math.min(1, available / natural) : 1 : zoom / 100
      element.style.setProperty('--paperai-page-zoom', factor.toFixed(3)); element.scrollTop = position * factor
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit); observer.observe(element)
    return () =>{  observer.disconnect() }
  }, [html, zoom])

  const report = (blocks: readonly HTMLElement[]): void => {
    const drafts = blocks.flatMap<{ block: HTMLElement; nodeId: PaperAIDocumentNodeId; draft: PaperAIBlockDraft | null }>((block) => {
      const nodeId = mapping.current.get(block)
      if (nodeId === undefined) return []
      const original = originals.current.get(block)
      const parts = readParagraphs(block)
      const runs = parts[0]?.runs ?? []
      const structured = parts.length > 1 || parts.some(part => part.format !== undefined)
      const text = parts.map(part => part.text).join('\n')
      const unchanged = !structured && original !== undefined && sameRuns(runs, original.runs)
      const stated = (list: readonly PaperAIDocumentTextRun[]): boolean => list.some(run => Object.keys(run).length > 1)
      const formatted = stated(runs) || (original !== undefined && stated(original.runs))
      const stating = original === undefined ? runs : restateCleared(runs, original.runs, block)
      return [{ block, nodeId, draft: unchanged ? null : { text,
        ...(structured ? { paragraphs: parts.map(part => ({ ...part,
          runs: original === undefined ? part.runs ?? [] : restateCleared(part.runs ?? [], original.runs, block),
        })) }
          : formatted ? { runs: stating } : {}),
      } }]
    })
    // Synchronous store subscribers must not repaint a later block from its previous draft.
    publishing.current = true
    try {
      for (const { block, nodeId, draft } of drafts) {
        callbacks.current.onDraft(nodeId, draft)
        block.toggleAttribute('data-paperai-changed', draft !== null)
        latest.current.set(block, imageOf(block))
      }
    } finally { publishing.current = false }
  }
  const finish = (blocks: readonly HTMLElement[], before = blocks.map(block => latest.current.get(block) ?? imageOf(block))): void => {
    const after = blocks.map(imageOf)
    if (after.some((image, index) => !sameImage(image, before[index] ?? image))) {
      history.current.past.push({ before, after }); history.current.future = []; updateHistory()
    }
    report(blocks)
    capture()
  }
  const undo = (redo = false): void => {
    if (!editable || composing.current) return
    const source = redo ? history.current.future : history.current.past
    const entry = source.pop()
    if (entry === undefined) return
    const images = redo ? entry.after : entry.before
    for (const image of images) restoreImage(image)
    report(images.map(image => image.block))
    const destination = redo ? history.current.past : history.current.future
    destination.push(entry); updateHistory()
    const block = images.at(-1)?.block
    if (block !== undefined) {
      block.focus({ preventScroll: true })
      let end: Node = paragraphsOf(block).at(-1) ?? block
      while (end.lastChild !== null) end = end.lastChild
      const range = document.createRange()
      if (end instanceof HTMLElement && end.dataset.paperaiPlaceholder !== undefined) range.setStartBefore(end)
      else range.selectNodeContents(end)
      range.collapse(false); select(range)
    }
  }
  const format = (patch: Readonly<Record<string, string>>): void => {
    const hit = target.current
    if (hit === null || !editable || composing.current) return
    const before = hit.blocks.map(imageOf)
    const ranges = selectedParagraphs(hit.range, hit.blocks).map(part => formatRange(part.range, part.block, patch))
    const first = ranges[0]; const last = ranges.at(-1)
    if (first === undefined || last === undefined) return
    const range = first.cloneRange(); range.setEnd(last.endContainer, last.endOffset)
    hit.blocks[0]?.focus({ preventScroll: true }); select(range)
    if (!range.collapsed) finish(hit.blocks, before)
  }
  const toggle = (key: 'b' | 'i' | 'u'): void => {
    const hit = target.current
    const now = hit === null ? null : selectionReading(hit.range, hit.blocks)
    if (now === null) return
    if (key === 'b') format({ 'font-weight': now.bold === true ? 'normal' : 'bold' })
    if (key === 'i') format({ 'font-style': now.italic === true ? 'normal' : 'italic' })
    if (key === 'u') format({ 'text-decoration': now.underline === true ? 'none' : 'underline' })
  }
  const paragraph = (patch: PaperAIParagraphFormat): void => {
    const hit = target.current
    if (hit === null || !editable || composing.current) return
    const before = hit.blocks.map(imageOf)
    formatParagraphs(hit.range, hit.blocks, patch); finish(hit.blocks, before); setCaret(selectionReading(hit.range, hit.blocks))
  }
  const insertText = (text: string, split: boolean): void => {
    const range = rangeNow() ?? target.current?.range
    if (range === undefined || !editable) return
    const blocks = [...mapping.current.keys()].filter(block =>
      range.collapsed ? block.contains(range.startContainer) : range.intersectsNode(block))
    const candidate = blocks.length === 1 ? blocks[0] : undefined
    const block = candidate?.contains(range.startContainer) === true && candidate.contains(range.endContainer) ? candidate : undefined
    if (block === undefined || (split && block.closest('td, th') !== null)) { setNotice('editor.structureProtected'); return }
    const before = [imageOf(block)]
    if (split) select(insertParagraphText(range, block, text.replace(/\r\n?/gu, '\n').split('\n')))
    else {
      range.deleteContents()
      const fragment = document.createDocumentFragment()
      text.split('\v').forEach((part, index) => { if (index > 0) fragment.append(document.createElement('br')); fragment.append(document.createTextNode(part)) })
      const last = fragment.lastChild; range.insertNode(fragment)
      if (last !== null) range.setStartAfter(last)
      range.collapse(true)
      if (text.endsWith('\v')) {
        const part = paragraphsOf(block).find(part => part.contains(range.startContainer)) ?? block
        const tail = range.cloneRange()
        tail.setEnd(part, part.childNodes.length)
        if (tail.toString() === '' && tail.cloneContents().querySelector('br') === null) {
          const placeholder = document.createElement('br')
          placeholder.dataset.paperaiPlaceholder = ''
          range.insertNode(placeholder)
          range.setStartBefore(placeholder); range.collapse(true)
        }
      }
      select(range)
    }
    finish([block], before)
  }

  useEffect(() => {
    const shadow = host.current?.shadowRoot
    if (shadow === null || shadow === undefined) return
    const container = shadow.querySelector<HTMLElement>('.paperai-doc')
    if (container === null) return
    const blockOf = (event: Event): HTMLElement | undefined => event.composedPath().find((node): node is HTMLElement =>
      node instanceof HTMLElement && mapping.current.has(node))
      ?? [...mapping.current.keys()].find(block => block.contains(rangeNow()?.startContainer ?? null))
    const input = (event: Event): void => {
      if (blockedComposition.current !== null) {
        blockedComposition.current()
        return
      }
      const block = blockOf(event)
      if (block !== undefined && editable && !composing.current) finish([block])
    }
    const beforeInput = (event: Event): void => {
      if (!(event instanceof InputEvent)) return
      if (!editable) { event.preventDefault(); return }
      const range = rangeNow()
      const block = range === null ? undefined : [...mapping.current.keys()]
        .find(block => block.contains(range.startContainer) && block.contains(range.endContainer))
      const outsideBlock = event.getTargetRanges().some(target =>
        block?.contains(target.startContainer) !== true || !block.contains(target.endContainer))
      if (blockedComposition.current !== null || block === undefined || outsideBlock
        || event.inputType === 'insertFromDrop' || event.inputType === 'deleteByDrag') {
        event.preventDefault(); setNotice('editor.structureProtected'); return
      }
      if (composing.current || event.isComposing) return
      if (range !== null && range.collapsed && /^delete.*(?:Backward|Forward)$/u.test(event.inputType)) {
        const backward = event.inputType.endsWith('Backward')
        const parts = paragraphsOf(block)
        const part = parts.find(part => part.contains(range.startContainer))
        const atEdge = part === undefined
          ? range.startOffset === (backward ? 0 : block.childNodes.length)
          : part === (backward ? parts[0] : parts.at(-1))
        const edge = range.cloneRange()
        if (backward) edge.setStart(block, 0)
        else edge.setEnd(block, block.childNodes.length)
        if (atEdge && edge.toString() === '' && edge.cloneContents().querySelector('br') === null) {
          event.preventDefault(); setNotice('editor.structureProtected'); return
        }
      }
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); undo(event.inputType === 'historyRedo'); return }
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        event.preventDefault(); insertText(event.inputType === 'insertParagraph' ? '\n' : '\v', event.inputType === 'insertParagraph'); return
      }
    }
    const paste = (event: Event): void => {
      if (!('clipboardData' in event)) return
      event.preventDefault()
      const text = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''
      insertText(text, /[\r\n]/u.test(text))
    }
    const keyDown = (event: Event): void => {
      if (!(event instanceof KeyboardEvent) || event.isComposing || composing.current) return
      const block = blockOf(event)
      if (block === undefined) return
      const command = event.metaKey || event.ctrlKey; const key = event.key.toLowerCase()
      if (command && (key === 's' || event.key === 'Enter')) { event.preventDefault(); callbacks.current.onSave(); return }
      if (command && (key === 'z' || key === 'y')) { event.preventDefault(); undo(key === 'y' || event.shiftKey); return }
      if (command && (key === 'b' || key === 'i' || key === 'u')) { event.preventDefault(); capture(); toggle(key); return }
      if (event.key === 'Enter') { event.preventDefault(); insertText(event.shiftKey ? '\v' : '\n', !event.shiftKey) }
      if (event.key === 'Escape') {
        const original = originals.current.get(block)
        if (original !== undefined && editable) { restoreImage(original.image); finish([block]); block.blur() }
      }
    }
    const compositionStart = (event: Event): void => {
      composing.current = true
      compositionBlock.current = blockOf(event) ?? null
      const range = rangeNow()
      if (range !== null && ![...mapping.current.keys()]
        .some(block => block.contains(range.startContainer) && block.contains(range.endContainer))) {
        blockedComposition.current = compositionSnapshot(container)
        setNotice('editor.structureProtected')
      }
    }
    const compositionEnd = (): void => {
      composing.current = false; const block = compositionBlock.current; compositionBlock.current = null
      if (blockedComposition.current !== null) {
        blockedComposition.current()
        blockedComposition.current = null
        target.current = null
        setCaret(null)
        return
      }
      if (block !== null && editable) finish([block])
    }
    const clicked = (event: Event): void => {
      if (event.composedPath().some(node => node instanceof HTMLElement && node.dataset.paperaiProtected !== undefined)) setNotice('editor.protected')
      else if (!conflicted) setNotice(null)
      capture()
    }
    const changed = (): void => { if (!composing.current) capture() }
    const listeners: readonly [string, EventListener][] = [['input', input], ['beforeinput', beforeInput], ['paste', paste], ['keydown', keyDown],
      ['compositionstart', compositionStart], ['compositionend', compositionEnd], ['click', clicked], ['keyup', changed], ['mouseup', changed]]
    listeners.forEach(([name, listener]) =>{  shadow.addEventListener(name, listener) }); document.addEventListener('selectionchange', changed)
    return () => { listeners.forEach(([name, listener]) =>{  shadow.removeEventListener(name, listener) }); document.removeEventListener('selectionchange', changed) }
  })

  const find = (query: string): boolean => {
    if (query === '') return false
    const blocks = [...host.current?.shadowRoot?.querySelectorAll<HTMLElement>('[data-paperai-block][data-path]') ?? []]
    const previous = findCursor.current?.query === query ? findCursor.current : null
    const start = previous === null ? 0 : Math.max(0, blocks.indexOf(previous.block))
    for (const [position, block] of [...blocks.slice(start), ...blocks.slice(0, start + 1)].entries()) {
      const text = block.textContent.toLocaleLowerCase()
      const offset = position === 0 && previous?.block === block ? previous.offset : 0
      const index = text.indexOf(query.toLocaleLowerCase(), offset)
      if (index < 0) continue
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      let consumed = 0
      let started = false
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const length = node.nodeValue?.length ?? 0
        if (!started && index < consumed + length) { range.setStart(node, index - consumed); started = true }
        if (started && index + query.length <= consumed + length) {
          range.setEnd(node, index + query.length - consumed)
          findCursor.current = { query, block, offset: index + query.length }
          select(range); block.scrollIntoView({ block: 'center' }); return true
        }
        consumed += length
      }
    }
    return false
  }
  const goToChange = (step: number): void => {
    const marked = [...host.current?.shadowRoot?.querySelectorAll<HTMLElement>('[data-paperai-change]') ?? []]
    if (marked.length === 0) return
    const index = (changes.index + step + marked.length) % marked.length
    marked.forEach((block, position) => block.toggleAttribute('data-paperai-current', position === index))
    marked[index]?.scrollIntoView({ block: 'center' }); setChanges({ count: marked.length, index })
  }
  return (
    <div className={css.previewSeat} hidden={!active} aria-hidden={!active || undefined}>
      {active && !comparing && <EditorRibbon caret={caret} fonts={fonts} paragraphStyles={paragraphStyles}
        disabled={!editable || composing.current} dirty={edits.length > 0}
        undo={historyState.undo} redo={historyState.redo} onSave={onSave} onUndo={() =>{  undo() }} onRedo={() =>{  undo(true) }}
        onToggle={toggle} onFormat={format} onParagraph={paragraph} onFind={find}
        quote={excerpt !== null} onQuote={onQuote === undefined ? undefined : () => {
          if (excerpt !== null) { onQuote(excerpt); setExcerpt(null) }
        }}
        onClear={() =>{  format({ 'font-weight': '', 'font-style': '', 'text-decoration': '', 'font-size': '', 'font-family': '', color: '' }) }} t={t} />}
      {active && notice !== null && <div className={css.notice} role="status">{t(notice)}</div>}
      <div ref={host} className={css.preview} role="document" aria-label={title} onScroll={(event) => { if (active) onScroll?.(event.currentTarget.scrollTop) }} />
      {active && comparing && changes.count > 0 && <div className={css.changeNav} role="group" aria-label={t('versions.changes')}>
        <span>{t('versions.changeNav', { index: changes.index + 1, count: changes.count })}</span>
        <button type="button" aria-label={t('versions.prev')} onClick={() =>{  goToChange(-1) }}><IconChevronDownOutline14 className={css.flipped ?? ''} /></button>
        <button type="button" aria-label={t('versions.next')} onClick={() =>{  goToChange(1) }}><IconChevronDownOutline14 /></button>
      </div>}
      {active && edits.length > 0 && <div className={css.pending} role="group" aria-label={t('block.pending', { count: edits.length })} data-paperai-pending>
        <span>{t('block.pending', { count: edits.length })}</span>
        {conflicted && <span role="alert">{t('block.conflicted')}</span>}
        <button className={css.chip} type="button" disabled={saving || busy} onClick={() => {
          for (const original of originals.current.values()) restoreImage(original.image)
          history.current = { past: [], future: [] }; updateHistory(); onCancel()
        }}>{t('block.discard')}</button>
        <button className={css.chip} type="button" data-kind="save" disabled={saving || busy || conflicted} onClick={onSave}>{saving ? t('block.saving') : t('block.save')}</button>
      </div>}
    </div>
  )
}
