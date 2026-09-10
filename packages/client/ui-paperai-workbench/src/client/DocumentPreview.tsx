/**
 * The document itself: the Host's preview rendered in a shadow tree so its own
 * stylesheet stays inside, with every addressed paragraph, heading, list item,
 * and table cell mapped back to a semantic node. Mapped blocks are typed into
 * directly, as in Word; each retyped block carries a marker until the drafts
 * are saved together as one version.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaperAIBlockEdit, PaperAIDocumentNodeId, PaperAIDocumentNodeSummary } from './types.ts'
import type { PaperAIDocumentWorkbenchProps } from './slots.ts'
import css from './DocumentWorkbench.module.css'
import { blocksOf, normalize } from './preview-html.ts'
import type { WordExcerpt } from './selection-context.ts'

/** Props of the editable preview and the save bar under it. */
export interface DocumentPreviewProps {
  readonly active?: boolean
  readonly scrollTop?: number
  readonly onScroll?: (scrollTop: number) => void
  readonly onQuote?: (excerpt: WordExcerpt) => void
  readonly html: string
  readonly nodes: readonly PaperAIDocumentNodeSummary[]
  readonly title: string
  /** Blocks retyped and not yet saved. */
  readonly edits: readonly PaperAIBlockEdit[]
  /** The HTML carries a version's marked changes; blocks stay read-only and a navigator walks the marks. */
  readonly comparing?: boolean
  readonly saving: boolean
  /** A mapped block now reads `value`; its original text drops the draft again. */
  readonly onDraft: (nodeId: PaperAIDocumentNodeId, value: string) => void
  readonly onSave: () => void
  readonly onCancel: () => void
  readonly t: PaperAIDocumentWorkbenchProps['t']
}

const DROPPED_ELEMENTS = 'script, iframe, object, embed, link, meta, base, form, input, button, textarea, select, noscript'
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction'])
const EDITABLE = 'contenteditable'

/** Styles the shadow tree needs beyond the document's own: block affordances and change marks. */
const PREVIEW_STYLE = `
:host { display: block; }
/* The Host renders the document as pages that paint their own white; the ink stays black in both color schemes
   (the Host sheet says so on body, which never reaches a shadow tree). The pages sit centered on the view's base tone
   with a hairline edge, zoomed down to fit the column when it is narrower than a page. */
.paperai-doc { width: fit-content; margin: 0 auto; color: var(--dsw-static-neutral-1000); zoom: var(--paperai-page-zoom, 1); }
.paperai-doc .page { outline: 1px solid var(--dsw-alias-border-l2); }
/* A compared change and a retyped block read alike: tinted, with a marker at the left edge. A retyped block whose
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

/** Render the preview with blocks written in place. */
export function DocumentPreview({
  html, nodes, title, edits, saving, onDraft, onSave, onCancel, t,
  active = true, scrollTop = 0, onScroll, onQuote, comparing = false,
}: DocumentPreviewProps): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const mapping = useRef(new Map<HTMLElement, PaperAIDocumentNodeId>())
  // Each mapped block as the Host rendered it, so a discarded draft brings its runs back.
  const originals = useRef(new Map<HTMLElement, Node>())
  const callbacks = useRef({ onDraft, onSave, nodes })
  callbacks.current = { onDraft, onSave, nodes }
  const [excerpt, setExcerpt] = useState<WordExcerpt | null>(null)
  const [changes, setChanges] = useState<{ readonly count: number; readonly index: number }>({ count: 0, index: 0 })

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
    originals.current = new Map([...mapping.current.keys()].map(block => [block, block.cloneNode(true)]))
    shadow.replaceChildren(style, container)
    setExcerpt(null)
    setChanges({ count: container.querySelectorAll('[data-paperai-change]').length, index: 0 })
  }, [html, nodes])

  // Mapped blocks show their drafts and carry a marker until saved; a dropped draft restores the Host's rendering.
  // A block being typed into already reads as its draft, so its caret is left alone.
  useLayoutEffect(() => {
    const drafts = new Map(edits.map(edit => [edit.nodeId, edit]))
    const editable = !comparing && !saving
    for (const [block, nodeId] of mapping.current) {
      const edit = drafts.get(nodeId)
      if (edit !== undefined && block.textContent !== edit.draft) block.textContent = edit.draft
      if (edit === undefined && block.textContent !== originals.current.get(block)?.textContent) {
        block.replaceChildren(...[...originals.current.get(block)?.childNodes ?? []].map(node => node.cloneNode(true)))
      }
      block.toggleAttribute('data-paperai-changed', edit !== undefined)
      block.toggleAttribute('data-paperai-conflicted', edit?.conflicted === true)
      if (editable && block.getAttribute(EDITABLE) === null) block.setAttribute(EDITABLE, 'plaintext-only')
      if (!editable) block.removeAttribute(EDITABLE)
    }
  }, [edits, comparing, saving, html, nodes])

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

  // Delegated listeners on the shadow tree: typing reports the block's text, keys revert or save, a selection quotes.
  useEffect(() => {
    const shadow = host.current?.shadowRoot
    if (shadow === null || shadow === undefined) return
    const blockOf = (event: Event): readonly [HTMLElement, PaperAIDocumentNodeId] | undefined => {
      const target = event.composedPath().find((node): node is HTMLElement => (
        node instanceof HTMLElement && node.dataset.paperaiBlock !== undefined
      ))
      const nodeId = target === undefined ? undefined : mapping.current.get(target)
      return target !== undefined && nodeId !== undefined ? [target, nodeId] : undefined
    }
    const onInput = (event: Event): void => {
      const hit = blockOf(event)
      if (hit !== undefined) callbacks.current.onDraft(hit[1], hit[0].textContent)
    }
    const onKeyDown = (event: Event): void => {
      const hit = blockOf(event)
      if (hit === undefined || !(event instanceof KeyboardEvent)) return
      // A block is one paragraph: Enter saves with a modifier and otherwise does nothing; Escape drops the block's draft.
      if (event.key === 'Enter') {
        event.preventDefault()
        if (event.metaKey || event.ctrlKey) callbacks.current.onSave()
      } else if (event.key === 'Escape') {
        callbacks.current.onDraft(hit[1], callbacks.current.nodes.find(node => node.nodeId === hit[1])?.text ?? '')
        hit[0].blur()
      }
    }
    const captureSelection = (): void => {
      const selection = (shadow as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.()
        ?? window.getSelection()
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return
      const range = selection.getRangeAt(0)
      const nodeIds = [...mapping.current.entries()]
        .filter(([block]) => range.intersectsNode(block))
        .map(([, nodeId]) => nodeId)
      const text = selection.toString()
      if (nodeIds.length > 0 && text.trim() !== '') setExcerpt({ nodeIds, text })
    }
    shadow.addEventListener('input', onInput)
    shadow.addEventListener('keydown', onKeyDown)
    shadow.addEventListener('click', captureSelection)
    shadow.addEventListener('keyup', captureSelection)
    return () => {
      shadow.removeEventListener('input', onInput)
      shadow.removeEventListener('keydown', onKeyDown)
      shadow.removeEventListener('click', captureSelection)
      shadow.removeEventListener('keyup', captureSelection)
    }
  }, [])

  const conflicted = edits.some(edit => edit.conflicted === true)
  return (
    <div className={css.previewSeat} hidden={!active} aria-hidden={!active || undefined}>
      {active && excerpt !== null && onQuote !== undefined && (
        <div className={css.notice} role="region" aria-label={t('selection.title')}>
          <span title={excerpt.text}>{excerpt.text}</span>
          <button className={css.chip} type="button" onMouseDown={(event) => { event.preventDefault() }} onClick={() => {
            onQuote(excerpt)
            setExcerpt(null)
          }}>{t('selection.ask')}</button>
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
