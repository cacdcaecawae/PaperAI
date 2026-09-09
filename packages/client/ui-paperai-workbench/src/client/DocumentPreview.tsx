/**
 * The document itself: the Host's read-only preview rendered in a shadow
 * tree so its own stylesheet stays inside, with every paragraph, heading,
 * list item, and table cell mapped back to a semantic node so a click edits
 * that block in place.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaperAIBlockEdit, PaperAIDocumentNodeId, PaperAIDocumentNodeSummary } from './types.ts'
import type { PaperAIDocumentWorkbenchProps } from './slots.ts'
import css from './DocumentWorkbench.module.css'
import { blocksOf, normalize } from './preview-html.ts'
import type { WordExcerpt } from './selection-context.ts'

/** Props of the in-place block editor and the preview around it. */
export interface DocumentPreviewProps {
  readonly active?: boolean
  readonly scrollTop?: number
  readonly onScroll?: (scrollTop: number) => void
  readonly onQuote?: (excerpt: WordExcerpt) => void
  readonly html: string
  readonly nodes: readonly PaperAIDocumentNodeSummary[]
  readonly title: string
  readonly editing: PaperAIBlockEdit | null
  /** The HTML carries a version's marked changes; blocks stay read-only and a navigator walks the marks. */
  readonly comparing?: boolean
  readonly saving: boolean
  /** A block was clicked; `null` reports one that matches no editable node. */
  readonly onSelectBlock: (nodeId: PaperAIDocumentNodeId | null) => void
  readonly onDraft: (value: string) => void
  readonly onSave: () => void
  readonly onCancel: () => void
  readonly t: PaperAIDocumentWorkbenchProps['t']
}

const DROPPED_ELEMENTS = 'script, iframe, object, embed, link, meta, base, form, input, button, textarea, select, noscript'
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction'])

/** Styles the shadow tree needs beyond the document's own: block affordances and the editor. */
const PREVIEW_STYLE = `
:host { display: block; }
/* The Host renders the document as pages that paint their own white; the ink stays black in both color schemes
   (the Host sheet says so on body, which never reaches a shadow tree). The pages sit centered on the view's base tone with a hairline edge. */
.paperai-doc { width: fit-content; margin: 0 auto; color: var(--dsw-static-neutral-1000); }
.paperai-doc .page { outline: 1px solid var(--dsw-alias-border-l2); }
/* Compare mode: a changed block is tinted with a marker at its left edge; deleted words are struck, inserted words underlaid. */
[data-paperai-change] { position: relative; margin-left: -12px; margin-right: -12px; border-radius: 4px; padding-left: 12px; padding-right: 12px; background: var(--dsw-alias-state-business-tertiary); }
[data-paperai-change]::before { content: ''; position: absolute; top: 6px; bottom: 6px; left: -10px; width: 3px; border-radius: 2px; background: var(--dsw-alias-state-business-primary); }
[data-paperai-change][data-paperai-current] { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
[data-paperai-change] del { border-radius: 3px; padding: 0 2px; background: var(--dsw-alias-state-error-tertiary, var(--dsw-alias-interactive-bg-hover-danger)); color: var(--dsw-alias-state-error-primary); text-decoration: line-through; }
[data-paperai-change] ins { border-radius: 3px; padding: 0 2px; background: var(--dsw-alias-state-success-tertiary, var(--dsw-alias-interactive-bg-hover)); color: var(--dsw-alias-state-success-primary); text-decoration: none; }
[data-paperai-block] { cursor: text; border-radius: 3px; transition: box-shadow 120ms ease; }
[data-paperai-block]:hover { box-shadow: 0 0 0 2px var(--dsw-alias-state-business-tertiary); }
[data-paperai-block][data-paperai-editing] { display: none; }
.paperai-editor-host { margin: 4px 0; }
.paperai-block-editor { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--dsw-alias-state-business-primary); border-radius: 8px; padding: 8px; background: var(--dsw-alias-bg-base); }
.paperai-block-editor textarea { box-sizing: border-box; width: 100%; min-height: 72px; resize: vertical; border: 0; padding: 4px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; line-height: 1.7; outline: none; }
.paperai-block-editor .paperai-editor-actions { display: flex; align-items: center; gap: 6px; }
.paperai-block-editor .paperai-editor-label { flex: 1; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.paperai-block-editor button { height: 28px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; padding: 0 12px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; font-size: 12px; line-height: 18px; }
.paperai-block-editor button[data-primary] { border-color: transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.paperai-block-editor button:disabled { cursor: default; opacity: 0.4; }
.paperai-block-editor button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { [data-paperai-block] { transition: none; } }
`

/** Drop active content and event handlers from the Host preview before it enters the page. */
function sanitize(html: string): { readonly styles: string; readonly body: Node[] } {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  for (const element of parsed.querySelectorAll(DROPPED_ELEMENTS)) element.remove()
  for (const element of parsed.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const raster = element.tagName === 'IMG' && name === 'src'
        && /^\s*data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,/iu.test(attribute.value)
      const scripted = URL_ATTRIBUTES.has(name) && /^\s*(?:javascript|data):/iu.test(attribute.value) && !raster
      if (name.startsWith('on') || scripted) element.removeAttribute(attribute.name)
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

/** The in-place editor: a textarea in the block's place, with save and cancel. */
function BlockEditor({ editing, saving, onDraft, onSave, onCancel, t }: Pick<
  DocumentPreviewProps, 'saving' | 'onDraft' | 'onSave' | 'onCancel' | 't'
> & { editing: PaperAIBlockEdit }): ReactNode {
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    textarea.current?.focus()
  }, [editing.nodeId])
  const dirty = editing.draft !== editing.baseText
  return (
    <div className="paperai-block-editor" data-paperai-block-editor>
      <textarea
        ref={textarea}
        aria-label={t('block.editing')}
        value={editing.draft}
        disabled={saving}
        onInput={(event) => { onDraft(event.currentTarget.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && dirty && !saving && editing.conflicted !== true) onSave()
        }}
      />
      {editing.conflicted === true && <p role="alert">{t('block.conflicted')}</p>}
      <div className="paperai-editor-actions">
        <span className="paperai-editor-label">{t('block.editing')}</span>
        <button type="button" disabled={saving} onClick={onCancel}>{t('block.cancel')}</button>
        <button type="button" data-primary="" disabled={saving || !dirty || editing.conflicted === true} onClick={onSave}>
          {saving ? t('block.saving') : t('block.save')}
        </button>
      </div>
    </div>
  )
}

/** Render the preview with block-level editing. */
export function DocumentPreview({
  html, nodes, title, editing, saving, onSelectBlock, onDraft, onSave, onCancel, t,
  active = true, scrollTop = 0, onScroll, onQuote, comparing = false,
}: DocumentPreviewProps): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const mapping = useRef(new Map<HTMLElement, PaperAIDocumentNodeId>())
  const [editorHost, setEditorHost] = useState<HTMLElement | null>(null)
  const select = useRef(onSelectBlock)
  select.current = onSelectBlock
  const compare = useRef(false)
  compare.current = comparing
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
    shadow.replaceChildren(style, container)
    setEditorHost(null)
    setExcerpt(null)
    setChanges({ count: container.querySelectorAll('[data-paperai-change]').length, index: 0 })
  }, [html, nodes])

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

  // One delegated click on the shadow tree resolves the block under the pointer.
  useEffect(() => {
    const shadow = host.current?.shadowRoot
    if (shadow === null || shadow === undefined) return
    const captureSelection = (): boolean => {
      const selection = (shadow as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.()
        ?? window.getSelection()
      if (selection !== null && !selection.isCollapsed && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        const nodeIds = [...mapping.current.entries()]
          .filter(([block]) => range.intersectsNode(block))
          .map(([, nodeId]) => nodeId)
        const text = selection.toString()
        if (nodeIds.length > 0 && text.trim() !== '') {
          setExcerpt({ nodeIds, text })
          return true
        }
      }
      return false
    }
    const onClick = (event: Event): void => {
      if (captureSelection() || compare.current) return
      const target = event.composedPath().find((node): node is HTMLElement => (
        node instanceof HTMLElement && node.dataset.paperaiBlock !== undefined
      ))
      if (target === undefined || event.composedPath().some(node => (
        node instanceof HTMLElement && node.dataset.paperaiBlockEditor !== undefined
      ))) return
      select.current(mapping.current.get(target) ?? null)
    }
    shadow.addEventListener('click', onClick)
    shadow.addEventListener('keyup', captureSelection)
    return () => {
      shadow.removeEventListener('click', onClick)
      shadow.removeEventListener('keyup', captureSelection)
    }
  }, [])

  // Put the editor in the edited block's place and restore the block afterwards.
  const editingNodeId = editing?.nodeId ?? null
  useLayoutEffect(() => {
    if (editingNodeId === null) {
      setEditorHost(null)
      return
    }
    const block = [...mapping.current.entries()].find(([, nodeId]) => nodeId === editingNodeId)?.[0]
    if (block === undefined) {
      setEditorHost(null)
      return
    }
    const seat = document.createElement('div')
    seat.className = 'paperai-editor-host'
    block.after(seat)
    block.dataset.paperaiEditing = ''
    setEditorHost(seat)
    return () => {
      seat.remove()
      delete block.dataset.paperaiEditing
    }
  }, [editingNodeId, html, nodes])

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
      {active && editorHost === null && editing?.conflicted === true && (
        <BlockEditor editing={editing} saving={saving} onDraft={onDraft} onSave={onSave} onCancel={onCancel} t={t} />
      )}
      {active && editorHost !== null && editing !== null && createPortal(
        <BlockEditor editing={editing} saving={saving} onDraft={onDraft} onSave={onSave} onCancel={onCancel} t={t} />,
        editorHost,
      )}
    </div>
  )
}
