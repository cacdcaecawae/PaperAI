/**
 * The document itself: the Host's preview rendered in a shadow tree so its own
 * stylesheet stays inside, with every addressed paragraph, heading, list item,
 * and table cell mapped back to a semantic node. Mapped blocks are typed into
 * directly, as in Word, and selected text takes bold, italic, underline, and a
 * font size; each changed block carries a marker until the drafts are saved
 * together as one version.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PaperAIBlockDraft, PaperAIBlockEdit, PaperAIDocumentNodeId, PaperAIDocumentNodeSummary, PaperAIDocumentTextRun,
} from './types.ts'
import type { PaperAIDocumentWorkbenchProps } from './slots.ts'
import css from './DocumentWorkbench.module.css'
import { applyRuns, blocksOf, boldOf, normalize, pointsOf, runsOf, sameRuns, underlineOf } from './preview-html.ts'
import type { WordExcerpt } from './selection-context.ts'

/** Props of the editable preview, its formatting controls, and the save bar under it. */
export interface DocumentPreviewProps {
  readonly active?: boolean
  readonly scrollTop?: number
  readonly onScroll?: (scrollTop: number) => void
  readonly onQuote?: (excerpt: WordExcerpt) => void
  readonly html: string
  readonly nodes: readonly PaperAIDocumentNodeSummary[]
  readonly title: string
  /** Blocks written into and not yet saved. */
  readonly edits: readonly PaperAIBlockEdit[]
  /** The HTML carries a version's marked changes; blocks stay read-only and a navigator walks the marks. */
  readonly comparing?: boolean
  readonly saving: boolean
  /** A mapped block now reads this; `null` says it reads as the document has it. */
  readonly onDraft: (nodeId: PaperAIDocumentNodeId, draft: PaperAIBlockDraft | null) => void
  readonly onSave: () => void
  readonly onCancel: () => void
  readonly t: PaperAIDocumentWorkbenchProps['t']
}

const DROPPED_ELEMENTS = 'script, iframe, object, embed, link, meta, base, form, input, button, textarea, select, noscript'
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction'])
const EDITABLE = 'contenteditable'
/** Point sizes the size control offers: the run of Chinese manuscript sizes from 五号 to 二号. */
const SIZES = [9, 10.5, 12, 14, 15, 16, 18, 22] as const

/** What the current selection reads, so the controls show what is on and what a click would change. */
interface CaretFormat {
  readonly bold: boolean
  readonly italic: boolean
  readonly underline: boolean
  /** The size stated over the block's own, or `''` when the selection reads as its block. */
  readonly size: string
}

/** Styles the shadow tree needs beyond the document's own: block affordances and change marks. */
const PREVIEW_STYLE = `
:host { display: block; }
/* The Host renders the document as pages that paint their own white; the ink stays black in both color schemes
   (the Host sheet says so on body, which never reaches a shadow tree). The pages sit centered on the view's base tone
   with a hairline edge, zoomed down to fit the column when it is narrower than a page. */
.paperai-doc { width: fit-content; margin: 0 auto; color: var(--dsw-static-neutral-1000); zoom: var(--paperai-page-zoom, 1); }
.paperai-doc .page { outline: 1px solid var(--dsw-alias-border-l2); }
/* A compared change and a written-into block read alike: tinted, with a marker at the left edge. A block whose
   text changed elsewhere turns the marker red. Deleted words are struck, inserted words underlaid. */
[data-paperai-change], [data-paperai-changed] { position: relative; margin-left: -12px; margin-right: -12px; border-radius: 4px; padding-left: 12px; padding-right: 12px; background: var(--dsw-alias-state-business-tertiary); }
[data-paperai-change]::before, [data-paperai-changed]::before { content: ''; position: absolute; top: 6px; bottom: 6px; left: -10px; width: 3px; border-radius: 2px; background: var(--dsw-alias-state-business-primary); }
[data-paperai-conflicted]::before { background: var(--dsw-alias-state-error-primary); }
[data-paperai-change][data-paperai-current] { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
[data-paperai-change] del { border-radius: 3px; padding: 0 2px; background: var(--dsw-alias-state-error-tertiary, var(--dsw-alias-interactive-bg-hover-danger)); color: var(--dsw-alias-state-error-primary); text-decoration: line-through; }
[data-paperai-change] ins { border-radius: 3px; padding: 0 2px; background: var(--dsw-alias-state-success-tertiary, var(--dsw-alias-interactive-bg-hover)); color: var(--dsw-alias-state-success-primary); text-decoration: none; }
/* Editable blocks are written in place, in their own type; the only chrome is a ring on hover and focus. */
[data-paperai-block][contenteditable] { cursor: text; border-radius: 3px; outline: none; transition: box-shadow 120ms ease; }
[data-paperai-block][contenteditable]:hover { box-shadow: 0 0 0 2px var(--dsw-alias-state-business-tertiary); }
[data-paperai-block][contenteditable]:focus { box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary); }
@media (prefers-reduced-motion: reduce) { [data-paperai-block] { transition: none; } }
`

/** Drop active content, event handlers, and editing flags from the Host preview before it enters the page. */
function sanitize(html: string): { readonly styles: string; readonly body: Node[] } {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  for (const element of parsed.querySelectorAll(DROPPED_ELEMENTS)) element.remove()
  for (const element of parsed.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const raster = element.tagName === 'IMG' && name === 'src'
        && /^\s*data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,/iu.test(attribute.value)
      const scripted = URL_ATTRIBUTES.has(name) && /^\s*(?:javascript|data):/iu.test(attribute.value) && !raster
      if (name.startsWith('on') || scripted || name === EDITABLE) element.removeAttribute(attribute.name)
    }
  }
  const styles = [...parsed.querySelectorAll('style')].map(style => style.textContent).join('\n')
  for (const style of parsed.querySelectorAll('style')) style.remove()
  return { styles, body: [...parsed.body.childNodes].map(node => document.importNode(node, true)) }
}

/**
 * Pair provider-addressed blocks by text and table-cell membership, consuming
 * repeated text in reading order. Page bands lack addresses and stay read-only.
 */
function mapBlocks(
  blocks: readonly HTMLElement[],
  nodes: readonly PaperAIDocumentNodeSummary[],
): Map<HTMLElement, PaperAIDocumentNodeId> {
  const byText = new Map<string, PaperAIDocumentNodeSummary[]>()
  nodes.filter(node => node.kind !== 'table').forEach((node) => {
    const key = normalize(node.text)
    byText.set(key, [...(byText.get(key) ?? []), node])
  })
  const used = new Set<PaperAIDocumentNodeId>()
  const mapping = new Map<HTMLElement, PaperAIDocumentNodeId>()
  blocks.forEach((block) => {
    if (!block.dataset.path) return
    const cell = block.closest('td, th') !== null
    const node = byText.get(normalize(block.textContent))?.find(candidate =>
      !used.has(candidate.nodeId) && (candidate.kind === 'table-cell') === cell)
    if (node === undefined) return
    used.add(node.nodeId)
    if (node.editable) mapping.set(block, node.nodeId)
  })
  return mapping
}

/** A paste event, recognized by what it carries rather than by its constructor. */
function carriesClipboard(event: Event): event is ClipboardEvent {
  return 'clipboardData' in event
}

/** The element a range sits in, so its rendered formatting can be read. */
function elementOf(range: Range): Element | null {
  const node = range.commonAncestorContainer
  return node instanceof Element ? node : node.parentElement
}

/** Read what a selection shows: absolutely for the toggles, and as an override for the size control. */
function caretOf(element: Element, block: HTMLElement): CaretFormat | null {
  const view = block.ownerDocument.defaultView
  if (view === null) return null
  const style = view.getComputedStyle(element)
  const size = pointsOf(style)
  return {
    bold: boldOf(style),
    italic: style.fontStyle === 'italic',
    underline: underlineOf(style),
    size: !Number.isFinite(size) || size === pointsOf(view.getComputedStyle(block)) ? '' : `${size}pt`,
  }
}

/** Render the preview with blocks written in place. */
export function DocumentPreview({
  html, nodes, title, edits, saving, onDraft, onSave, onCancel, t,
  active = true, scrollTop = 0, onScroll, onQuote, comparing = false,
}: DocumentPreviewProps): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const mapping = useRef(new Map<HTMLElement, PaperAIDocumentNodeId>())
  // Each mapped block as the Host rendered it: the nodes that restore a dropped draft, and the runs to
  // compare against, read while the block is attached because a detached clone has no rendered style.
  const originals = useRef(new Map<HTMLElement, { node: Node; runs: readonly PaperAIDocumentTextRun[] }>())
  const callbacks = useRef({ onDraft, onSave })
  callbacks.current = { onDraft, onSave }
  // The live selection the formatting controls act on, kept out of state because a Range is mutable.
  const target = useRef<{ range: Range; block: HTMLElement; nodeId: PaperAIDocumentNodeId } | null>(null)
  const [excerpt, setExcerpt] = useState<WordExcerpt | null>(null)
  const [caret, setCaret] = useState<CaretFormat | null>(null)
  const [changes, setChanges] = useState<{ readonly count: number; readonly index: number }>({ count: 0, index: 0 })
  const editable = !comparing && !saving

  // Rebuild the shadow tree whenever the Host sends new HTML or nodes.
  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' })
    const { styles, body } = sanitize(html)
    const style = document.createElement('style')
    style.textContent = `${styles}\n${PREVIEW_STYLE}`
    const container = document.createElement('div')
    container.className = 'paperai-doc'
    container.append(...body)
    const blocks = blocksOf(container)
    blocks.forEach((block, index) => { block.dataset.paperaiBlock = String(index) })
    mapping.current = mapBlocks(blocks, nodes)
    shadow.replaceChildren(style, container)
    originals.current = new Map([...mapping.current.keys()]
      .map(block => [block, { node: block.cloneNode(true), runs: runsOf(block) }]))
    setExcerpt(null)
    setCaret(null)
    target.current = null
    setChanges({ count: container.querySelectorAll('[data-paperai-change]').length, index: 0 })
  }, [html, nodes])

  // Mapped blocks show their drafts and carry a marker until saved; a dropped draft restores the Host's
  // rendering. The block being written into owns its own contents, so its caret is left alone.
  useLayoutEffect(() => {
    const drafts = new Map(edits.map(edit => [edit.nodeId, edit]))
    const focused = host.current?.shadowRoot?.activeElement
    for (const [block, nodeId] of mapping.current) {
      const edit = drafts.get(nodeId)
      const original = originals.current.get(block)
      if (block !== focused) {
        if (edit?.runs !== undefined && !sameRuns(runsOf(block), edit.runs)) applyRuns(block, edit.runs)
        else if (edit !== undefined && block.textContent !== edit.draft) block.textContent = edit.draft
        else if (edit === undefined && original !== undefined && block.hasAttribute('data-paperai-changed')) {
          block.replaceChildren(...[...original.node.childNodes].map(node => node.cloneNode(true)))
        }
      }
      block.toggleAttribute('data-paperai-changed', edit !== undefined)
      block.toggleAttribute('data-paperai-conflicted', edit?.conflicted === true)
      if (editable && block.getAttribute(EDITABLE) === null) block.setAttribute(EDITABLE, 'true')
      if (!editable) block.removeAttribute(EDITABLE)
    }
  }, [edits, editable, html, nodes])

  // The change navigator walks the marked blocks; the current one is outlined and scrolled into view.
  const goToChange = (step: number): void => {
    const marked = [...host.current?.shadowRoot?.querySelectorAll<HTMLElement>('[data-paperai-change]') ?? []]
    if (marked.length === 0) return
    const index = (changes.index + step + marked.length) % marked.length
    marked.forEach((block, position) => {
      if (position === index) block.dataset.paperaiCurrent = ''
      else delete block.dataset.paperaiCurrent
    })
    marked[index]?.scrollIntoView({ block: 'center' })
    setChanges({ count: marked.length, index })
  }

  useLayoutEffect(() => {
    if (active && host.current !== null) host.current.scrollTop = scrollTop
  }, [active, html, scrollTop])

  // Zoom the pages down when the column is narrower than a page, and follow the column as it resizes.
  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    const fit = (): void => {
      const pages = element.shadowRoot?.querySelector<HTMLElement>('.paperai-doc')
      if (pages === undefined || pages === null) return
      element.style.setProperty('--paperai-page-zoom', '1')
      const style = getComputedStyle(element)
      const available = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const natural = pages.offsetWidth
      const zoom = natural > 0 && available > 0 && available < natural ? available / natural : 1
      element.style.setProperty('--paperai-page-zoom', zoom.toFixed(3))
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [html])

  // Report what a block now reads. A block spelling its original text with its original runs has no draft.
  const report = (block: HTMLElement, nodeId: PaperAIDocumentNodeId): void => {
    const original = originals.current.get(block)
    const runs = runsOf(block)
    const text = block.textContent
    const unchanged = original !== undefined
      && normalize(text) === normalize(original.node.textContent ?? '')
      && sameRuns(runs, original.runs)
    // Runs travel only when they state formatting; a plain block commits as one engine operation.
    const formatted = runs.some(run => Object.keys(run).length > 1)
    callbacks.current.onDraft(nodeId, unchanged ? null : { text, ...(formatted ? { runs } : {}) })
  }

  /**
   * Wrap the selection in a span stating the given declarations, clearing the
   * same declarations inside it so the new value is the one that reads.
   */
  const format = (patch: Readonly<Record<string, string>>): void => {
    const hit = target.current
    if (hit === null || !editable) return
    // A repeated change acts on the wrapper the last one left, so its own declarations clear first.
    const covered = hit.range.commonAncestorContainer
    if (covered instanceof HTMLElement && covered !== hit.block
      && hit.range.startOffset === 0 && hit.range.endOffset === covered.childNodes.length) {
      for (const property of Object.keys(patch)) covered.style.removeProperty(property)
    }
    const fragment = hit.range.extractContents()
    for (const element of fragment.querySelectorAll<HTMLElement>('*')) {
      for (const property of Object.keys(patch)) element.style.removeProperty(property)
    }
    const span = hit.block.ownerDocument.createElement('span')
    for (const [property, value] of Object.entries(patch)) if (value !== '') span.style.setProperty(property, value)
    span.append(fragment)
    hit.range.insertNode(span)
    const range = hit.block.ownerDocument.createRange()
    range.selectNodeContents(span)
    target.current = { ...hit, range }
    setCaret(caretOf(span, hit.block))
    report(hit.block, hit.nodeId)
  }

  const toggle = (key: string): void => {
    const hit = target.current
    const element = hit === null ? null : elementOf(hit.range)
    const now = element === null || hit === null ? null : caretOf(element, hit.block)
    if (now === null) return
    if (key === 'b') format({ 'font-weight': now.bold ? 'normal' : 'bold' })
    if (key === 'i') format({ 'font-style': now.italic ? 'normal' : 'italic' })
    if (key === 'u') format({ 'text-decoration': now.underline ? 'none' : 'underline' })
  }

  // Delegated listeners on the shadow tree: typing reports the block, keys revert, save, or format,
  // a paste stays plain text, and a selection offers quoting and the formatting controls.
  useEffect(() => {
    const shadow = host.current?.shadowRoot
    if (shadow === null || shadow === undefined) return
    const blockOf = (event: Event): readonly [HTMLElement, PaperAIDocumentNodeId] | undefined => {
      const found = event.composedPath().find((node): node is HTMLElement => (
        node instanceof HTMLElement && node.dataset.paperaiBlock !== undefined
      ))
      const nodeId = found === undefined ? undefined : mapping.current.get(found)
      return found !== undefined && nodeId !== undefined ? [found, nodeId] : undefined
    }
    const rangeNow = (): Range | null => {
      const selection = (shadow as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.()
        ?? window.getSelection()
      return selection === null || selection.rangeCount === 0 ? null : selection.getRangeAt(0)
    }
    const onInput = (event: Event): void => {
      const hit = blockOf(event)
      if (hit !== undefined) report(hit[0], hit[1])
    }
    const onPaste = (event: Event): void => {
      const hit = blockOf(event)
      if (hit === undefined || !carriesClipboard(event)) return
      // A block is one paragraph of the document, so pasted markup enters as its text alone.
      event.preventDefault()
      const range = rangeNow()
      if (range === null) return
      range.deleteContents()
      range.insertNode(hit[0].ownerDocument.createTextNode(event.clipboardData?.getData('text/plain') ?? ''))
      range.collapse(false)
      report(hit[0], hit[1])
    }
    const onKeyDown = (event: Event): void => {
      const hit = blockOf(event)
      if (hit === undefined || !(event instanceof KeyboardEvent)) return
      const command = event.metaKey || event.ctrlKey
      // A block is one paragraph: Enter saves with a modifier and otherwise does nothing; Escape drops the draft.
      if (event.key === 'Enter') {
        event.preventDefault()
        if (command) callbacks.current.onSave()
      } else if (event.key === 'Escape') {
        callbacks.current.onDraft(hit[1], null)
        hit[0].blur()
      } else if (command && 'biu'.includes(event.key.toLowerCase())) {
        event.preventDefault()
        toggle(event.key.toLowerCase())
      }
    }
    const captureSelection = (): void => {
      const range = rangeNow()
      // A collapsed selection leaves nothing to format; the controls go before they can act on stale text.
      if (range === null || range.collapsed) {
        target.current = null
        setCaret(null)
        return
      }
      const entries = [...mapping.current.entries()].filter(([block]) => range.intersectsNode(block))
      const text = range.toString()
      if (entries.length === 0 || text.trim() === '') return
      setExcerpt({ nodeIds: entries.map(([, nodeId]) => nodeId), text })
      // Formatting rewrites the selected text in place, so it acts within one block.
      const single = entries.length === 1 ? entries[0] : undefined
      const element = elementOf(range)
      const inside = single !== undefined && element !== null && single[0].contains(element) ? { single, element } : null
      target.current = inside === null
        ? null
        : { range: range.cloneRange(), block: inside.single[0], nodeId: inside.single[1] }
      setCaret(inside === null || !editable ? null : caretOf(inside.element, inside.single[0]))
    }
    shadow.addEventListener('input', onInput)
    shadow.addEventListener('paste', onPaste)
    shadow.addEventListener('keydown', onKeyDown)
    shadow.addEventListener('click', captureSelection)
    shadow.addEventListener('keyup', captureSelection)
    return () => {
      shadow.removeEventListener('input', onInput)
      shadow.removeEventListener('paste', onPaste)
      shadow.removeEventListener('keydown', onKeyDown)
      shadow.removeEventListener('click', captureSelection)
      shadow.removeEventListener('keyup', captureSelection)
    }
  })

  // A size the document already uses joins the offered ones, so the control never misreads it as the block's own.
  const sizes = [...new Set([...SIZES, ...(caret === null || caret.size === '' ? [] : [parseFloat(caret.size)])])]
    .sort((left, right) => left - right)
  const conflicted = edits.some(edit => edit.conflicted === true)
  const toggles = [['b', 'block.bold', caret?.bold], ['i', 'block.italic', caret?.italic],
    ['u', 'block.underline', caret?.underline]] as const
  return (
    <div className={css.previewSeat} hidden={!active} aria-hidden={!active || undefined}>
      {active && excerpt !== null && (
        <div className={css.notice} role="region" aria-label={t('selection.title')}>
          <span title={excerpt.text}>{excerpt.text}</span>
          {caret !== null && (
            <div className={css.format} role="group" aria-label={t('block.format')}>
              {toggles.map(([key, label, on]) => (
                <button key={key} className={css.chip} type="button" aria-pressed={on === true} data-format={key}
                  onMouseDown={(event) => { event.preventDefault() }} onClick={() => { toggle(key) }}>
                  {t(label)}
                </button>
              ))}
              <select className={css.size} aria-label={t('block.size')} value={caret.size}
                onChange={(event) => { format({ 'font-size': event.target.value }) }}>
                <option value="">{t('block.sizeInherit')}</option>
                {sizes.map(size => <option key={size} value={`${size}pt`}>{size}</option>)}
              </select>
            </div>
          )}
          {onQuote !== undefined && (
            <button className={css.chip} type="button" onMouseDown={(event) => { event.preventDefault() }} onClick={() => {
              onQuote(excerpt)
              setExcerpt(null)
            }}>{t('selection.ask')}</button>
          )}
          <button className={css.chip} type="button" onClick={() => { setExcerpt(null) }}>{t('selection.dismiss')}</button>
        </div>
      )}
      <div ref={host} className={css.preview} role="document" aria-label={title}
        onScroll={(event) => { if (active) onScroll?.(event.currentTarget.scrollTop) }} />
      {active && comparing && changes.count > 0 && (
        <div className={css.changeNav} role="group" aria-label={t('versions.changes')}>
          <span>{t('versions.changeNav', { index: changes.index + 1, count: changes.count })}</span>
          <button type="button" aria-label={t('versions.prev')} onClick={() => { goToChange(-1) }}>
            <IconChevronDownOutline14 className={css.flipped ?? ''} />
          </button>
          <button type="button" aria-label={t('versions.next')} onClick={() => { goToChange(1) }}>
            <IconChevronDownOutline14 />
          </button>
        </div>
      )}
      {active && edits.length > 0 && (
        <div className={css.pending} role="group" aria-label={t('block.pending', { count: edits.length })} data-paperai-pending>
          <span>{t('block.pending', { count: edits.length })}</span>
          {conflicted && <span role="alert">{t('block.conflicted')}</span>}
          <button className={css.chip} type="button" disabled={saving} onClick={onCancel}>{t('block.discard')}</button>
          <button className={css.chip} type="button" data-kind="save" disabled={saving || conflicted} onClick={onSave}>
            {saving ? t('block.saving') : t('block.save')}
          </button>
        </div>
      )}
    </div>
  )
}
