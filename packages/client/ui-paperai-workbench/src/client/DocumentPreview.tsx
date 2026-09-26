/** Editable Host preview with temporary block drafts, document commands, and local undo history. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14, IconPlusOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaperAIBlockDraft, PaperAIBlockEdit, PaperAIDocumentNodeId, PaperAIDocumentNodeSummary, PaperAIDocumentSnapshot, PaperAIDocumentTextRun, PaperAIParagraphFormat } from './types.ts'
import type { PaperAIDocumentWorkbenchProps } from './slots.ts'
import css from './DocumentWorkbench.module.css'
import { applyParagraphs, applyRuns, blocksOf, conflictBand, effectiveRunsOf, fontOf, normalize, paragraphsOf, restateCleared, runsOf, sameRuns, textOf, type ConflictBandSide } from './preview-html.ts'
import { formatParagraphs, formatRange, insertParagraphText, readParagraphs, selectedParagraphs, selectionReading } from './editor-dom.ts'
import { EditorRibbon, type EditorFormat } from './EditorRibbon.tsx'
import { IconZoomOut } from './editor-icons.tsx'
import type { WordExcerpt } from './selection-context.ts'

/** Editable document projection and commands owned by the workbench. */
export interface DocumentPreviewProps {
  readonly active?: boolean
  readonly scrollTop?: number
  readonly reveal?: { readonly nodeId: PaperAIDocumentNodeId; readonly tick: number } | null
  readonly zoom?: number | 'fit'
  readonly onZoom?: (zoom: number | 'fit') => void
  readonly onScroll?: (scrollTop: number) => void
  /** Hand the selection to the Agent, with one of the canned requests when the menu named it. */
  readonly onQuote?: (excerpt: WordExcerpt, request?: string) => void
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
  /** Keep the local draft on one conflicted block: rebase it onto the document's text and unfreeze it. */
  readonly onResolveConflict?: (nodeId: PaperAIDocumentNodeId) => void
  readonly onSave: () => void
  readonly onCancel: () => void
  readonly t: PaperAIDocumentWorkbenchProps['t']
}

/**
 * Copy printed on one conflict band.
 * @param form - `document` quotes the document and offers both sides; `draft` quotes a draft no keystroke can reach.
 * @param t - the workbench translator.
 * @returns the resolved strings and the buttons this form can carry.
 */
function bandCopy(form: ConflictBandSide['form'], t: PaperAIDocumentWorkbenchProps['t']): ConflictBandSide['copy'] {
  return {
    who: t(form === 'draft' ? 'editor.conflictMine' : 'editor.conflictTheirs'),
    legend: t(form === 'draft' ? 'editor.conflictUnmergeable' : 'editor.conflictLegend'),
    rewritten: t('editor.conflictRewritten'),
    empty: t('editor.conflictEmpty'),
    // No 用我的 on a draft band: no caret can enter that paragraph, so the button would promise a
    // merge the browser cannot deliver — which is the promise the frozen-block copy makes today.
    actions: form === 'draft'
      ? [{ resolve: 'copy', label: t('editor.conflictCopy') }, { resolve: 'drop', label: t('editor.conflictDrop') }]
      : [{ resolve: 'mine', label: t('editor.conflictKeep') }, { resolve: 'theirs', label: t('editor.conflictTake') }],
  }
}

const DROPPED_ELEMENTS = 'script, iframe, object, embed, link, meta, base, form, input, button, textarea, select, noscript'
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction'])
const COMPLEX = 'img, svg, math, canvas, video, audio, a, table, [data-field], [data-formula], .katex-formula, .equation, .math, .field, sup, sub'
/** Zoom steps the pill walks through; fit-to-width reports where it landed between them. */
const ZOOMS = [50, 75, 100, 125, 150, 200]
const PREVIEW_STYLE = `
:host { display: block; }
.paperai-doc { width: fit-content; margin: 0 auto; color: var(--dsw-static-neutral-1000); zoom: var(--paperai-page-zoom, 1); }
.paperai-doc .page { border: 1px solid var(--dsw-alias-border-l2); border-radius: 2px; box-shadow: var(--paperai-page-shadow); }
[data-paperai-change], [data-paperai-changed] { position: relative; }
/* Marks drawn on the sheet take the page's own gold, not the app's: --dsw-alias-state-business-primary
   resolves to champagne #e2b457 in dark, which is 1.9:1 on white paper. */
[data-paperai-change]::before, [data-paperai-changed]::before { content: '✎'; position: absolute; left: -20px; top: 0; font: 12px sans-serif; color: var(--paperai-page-accent); }
[data-paperai-conflicted]::before { content: '!'; font-weight: bold; color: var(--dsw-alias-state-error-primary); }
[data-paperai-conflicted] { border-inline-start: 2px dashed var(--dsw-alias-state-error-primary); }
[data-paperai-change][data-paperai-current] { outline: 2px solid var(--paperai-page-accent); outline-offset: 2px; }
[data-paperai-removed] { opacity: 0.85; }
/* A version comparison keeps its own red-removed/green-added reading; what goes is the tint behind it.
   --dsw-alias-state-error-tertiary is defined in neither scheme, so that one was already doing nothing,
   and --dsw-alias-state-success-tertiary resolves to green-900 in dark: a near-black block on white
   paper. A background is also what turns dense Chinese into confetti and what breaks CJK line-breaking,
   so the strike and the underline carry the shape instead. */
[data-paperai-change] del { color: var(--dsw-alias-state-error-primary); text-decoration: line-through; text-decoration-thickness: 0.06em; }
[data-paperai-change] ins { color: var(--dsw-alias-state-success-primary); text-decoration: underline; text-decoration-skip-ink: none; text-decoration-thickness: 0.06em; text-underline-offset: 0.2em; }
[data-paperai-block][contenteditable="true"] { cursor: text; outline: none; min-height: 1em; caret-color: var(--paperai-page-accent); }
[data-paperai-paragraph] { display: block; min-height: 1em; }

/* ── A conflict, shown in the page ──────────────────────────────────────────────────────────────
   A tint block hung from a gold rule, seated in the paper at the page's own measure. No shadow, no
   blur, no hairline and no position: those are the four things that would make it read as something
   lying on the sheet rather than as a state the paragraph is in. No hover on the box either — in a
   typing surface the mouse parks anywhere, and three boxes lighting up while the writer types is a
   flicker that buys nothing. Texture is authorship, and it is one word in both forms: a solid rule
   stands beside the document's text, a dashed rule beside your draft.
   The grid row is what lets real height animate, so the thesis is pushed rather than jumped, and
   overflow-anchor keeps the browser from anchoring scroll on the band instead of on the paragraph
   the writer is reading. */
[data-paperai-conflict] {
  display: grid; grid-template-rows: 0fr; opacity: 0;
  margin: 1.1em 0 0.3em; border-inline-start: 2px solid var(--paperai-page-accent); border-radius: 2px;
  background: color-mix(in srgb, var(--paperai-page-accent) 10%, transparent);
  overflow-anchor: none; text-align: start; text-indent: 0;
  transition: grid-template-rows 160ms ease, margin-block 160ms ease, opacity 160ms ease;
}
[data-paperai-conflict][data-paperai-open] { grid-template-rows: 1fr; opacity: 1; }
[data-paperai-conflict][data-paperai-conflict-form="draft"] { border-inline-start-style: dashed; }
.paperai-conflict-body { min-height: 0; overflow: hidden; padding-inline: 0.85em; }
/* The band and its paragraph are two stanzas of one object, so the paragraph wears the opposite
   texture, and the red ! it would otherwise carry goes: a band standing above explains the conflict
   better than a glyph, and two marks in one gutter is noise. */
[data-paperai-conflict-seat="mine"] { border-inline-start: 2px dashed var(--paperai-page-accent); }
[data-paperai-conflict-seat="theirs"] { border-inline-start: 2px solid var(--paperai-page-accent); }
[data-paperai-conflict-seat]::before { content: none; }

/* Chrome register: 13px type and 28px targets on screen at every zoom, because these are the same
   kind of thing as the zoom pill and the page counter, and a 28px button at a 50% fit is 14px of
   screen the writer misses. Sized through --paperai-page-relief (= 1 / --paperai-page-zoom, written
   by the same fit() that writes the zoom) rather than a reciprocal zoom, which would nest a second
   coordinate context inside the editing host that three getBoundingClientRect callers read. */
.paperai-conflict-head, .paperai-conflict-acts {
  display: flex; align-items: center; gap: calc(8px * var(--paperai-page-relief, 1));
  font-family: var(--dsw-font-family); user-select: none;
}
.paperai-conflict-head {
  min-height: calc(24px * var(--paperai-page-relief, 1)); padding-top: calc(6px * var(--paperai-page-relief, 1));
  font-size: calc(13px * var(--paperai-page-relief, 1)); line-height: calc(20px * var(--paperai-page-relief, 1));
}
/* The one line a glance has to resolve: whose words these are. */
.paperai-conflict-who { flex: none; font-weight: 500; color: var(--paperai-page-accent); }
/* Names both marks in words, so neither depends on hue. --dsw-static-* is the register the page
   already uses and does not flip, which is what a white-in-both-schemes sheet needs. */
.paperai-conflict-legend {
  min-width: 0; overflow: hidden; color: var(--dsw-static-neutral-550);
  font-size: calc(12px * var(--paperai-page-relief, 1)); text-overflow: ellipsis; white-space: nowrap;
}
/* Prose register: the document's own face, size and leading, inherited, because this quotation is
   read straight down against the paragraph below it and two texts at two scales cannot be compared
   by eye. Context is demoted so the marked words come forward. */
.paperai-conflict-text { margin: 0.35em 0 0; color: var(--dsw-static-neutral-600); user-select: text; }
.paperai-conflict-empty { color: var(--dsw-static-neutral-550); font-style: italic; }
/* Deliberately not the comparison's red-and-green above: neither side here is deleted, and one of them
   is the writer's own sentence. In the document now and not in your draft comes forward to full ink and
   takes a gold underline — skip-ink off, because it shreds under 一 丁 冖, and the offset clears 宋体's
   low horizontal strokes. In your draft and dropped by the document takes the one red the page spends. */
.paperai-conflict-text ins { color: var(--dsw-static-neutral-1000); text-decoration: underline; text-decoration-color: var(--paperai-page-accent); text-decoration-skip-ink: none; text-decoration-thickness: 0.06em; text-underline-offset: 0.2em; }
.paperai-conflict-text del { color: var(--paperai-page-loss); text-decoration: line-through; text-decoration-thickness: 0.06em; }

.paperai-conflict-acts { justify-content: flex-end; gap: calc(2px * var(--paperai-page-relief, 1)); padding: calc(4px * var(--paperai-page-relief, 1)) 0 calc(6px * var(--paperai-page-relief, 1)); }
/* The grammar's control: no border, radius 8, 28px. Its fills mix from the page accent rather than
   --dsw-alias-interactive-bg-hover, which is white at 7% in dark and so has no value over a sheet. */
.paperai-conflict-act {
  height: calc(28px * var(--paperai-page-relief, 1)); border: 0; border-radius: calc(8px * var(--paperai-page-relief, 1));
  padding: 0 calc(10px * var(--paperai-page-relief, 1)); background: transparent; color: var(--dsw-static-neutral-600);
  cursor: pointer; font-weight: 500; font-size: calc(13px * var(--paperai-page-relief, 1));
  line-height: calc(20px * var(--paperai-page-relief, 1)); font-family: var(--dsw-font-family);
}
.paperai-conflict-act:hover { background: color-mix(in srgb, var(--paperai-page-accent) 14%, transparent); color: var(--dsw-static-neutral-1000); }
.paperai-conflict-act:active { background: color-mix(in srgb, var(--paperai-page-accent) 22%, transparent); }
/* Inset, because .paperai-conflict-body clips and an outset ring would be cut. */
.paperai-conflict-act:focus-visible { outline: 2px solid var(--paperai-page-accent); outline-offset: -2px; }
/* 用我的 destroys nothing, so it carries the grammar's SELECTED fill, not the primary fill: the
   screen's one filled action stays 导出 in the header, and three bands add no gold button to the page. */
.paperai-conflict-act[data-paperai-resolve="mine"] { background: var(--dsw-alias-state-business-tertiary); color: var(--paperai-page-accent); }
/* Second press of 放弃这段草稿, the only other place the page spends red. */
.paperai-conflict-act[data-paperai-armed] { background: color-mix(in srgb, var(--paperai-page-loss) 10%, transparent); color: var(--paperai-page-loss); }

/* The Host paginated this page before the band existed, so a page carrying one has to grow rather
   than clip its last lines. Defensive: the .page rule ships with the Host's preview HTML, from
   office-cli and not from this repo, so this is a no-op unless that CSS fixes a height. */
.page:has([data-paperai-conflict]) { height: auto; overflow: visible; }
/* The exit still has to fire transitionend, which is what removes the node. */
@media (prefers-reduced-motion: reduce) { [data-paperai-conflict] { transition-duration: 1ms; } }
/* Browser furniture: manufactured into the projection, never into the .docx. */
@media print { [data-paperai-conflict] { display: none; } [data-paperai-conflict-seat] { border-inline-start: 0; } }
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

/** The canned selection actions: menu id, its label, and the request that follows the quoted text into the composer. */
const SELECTION_REQUESTS = [
  ['polish', 'selection.polish', 'selection.polishRequest'],
  ['expand', 'selection.expand', 'selection.expandRequest'],
  ['citations', 'selection.citations', 'selection.citationsRequest'],
] as const

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
    // Every identified block names its node, mapped or not. That is what gives a conflict on an
    // unmergeable paragraph a seat to stand above: it is identified, so its draft exists, but it is
    // not in `mapping`, so nothing else in the component can find it.
    block.dataset.paperaiNode = node.nodeId
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
  active = true, scrollTop = 0, zoom = 'fit', onScroll, onQuote, onZoom, onResolveConflict, comparing = false, busy = false, reveal = null,
}: DocumentPreviewProps): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const mapping = useRef(new Map<HTMLElement, PaperAIDocumentNodeId>())
  const originals = useRef(new Map<HTMLElement, {
    image: BlockImage
    runs: readonly PaperAIDocumentTextRun[]
    effective: readonly PaperAIDocumentTextRun[]
  }>())
  const latest = useRef(new Map<HTMLElement, BlockImage>())
  const history = useRef<{ past: HistoryEntry[]; future: HistoryEntry[] }>({ past: [], future: [] })
  const publishing = useRef(false)
  const composing = useRef(false)
  const compositionBlock = useRef<HTMLElement | null>(null)
  const blockedComposition = useRef<(() => void) | null>(null)
  const target = useRef<{ range: Range; blocks: HTMLElement[] } | null>(null)
  const findCursor = useRef<{ query: string; block: HTMLElement; offset: number } | null>(null)
  /** The half-pressed 放弃这段草稿, if one is waiting for its second press. */
  const armed = useRef<HTMLElement | null>(null)
  const callbacks = useRef({ onDraft, onSave })
  callbacks.current = { onDraft, onSave }
  const [caret, setCaret] = useState<EditorFormat | null>(null)
  const [excerpt, setExcerpt] = useState<WordExcerpt | null>(null)
  const [historyState, setHistoryState] = useState({ undo: false, redo: false })
  const [notice, setNotice] = useState<'editor.protected' | 'editor.conflict' | 'editor.structureProtected' | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [changes, setChanges] = useState({ count: 0, index: 0 })
  // Where a right-click on selected text opened the selection menu.
  const [context, setContext] = useState<{ x: number; y: number } | null>(null)
  /** Where the selection bar hangs, relative to the stage: centred under the selection's last line, or above it when there is no room. */
  const [bar, setBar] = useState<{ x: number; y: number; above: number } | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [fonts, setFonts] = useState<readonly string[]>([])
  const [fitPercent, setFitPercent] = useState(100)
  const [pages, setPages] = useState({ current: 1, total: 0 })
  const [zoomOpen, setZoomOpen] = useState(false)
  const conflicted = edits.some(edit => edit.conflicted === true)
  // Not while the retry runs, and not over a conflict that already explains itself.
  const saveFailed = !saving && !conflicted && edits.some(edit => edit.saveFailed === true)
  const editable = !comparing && !saving && !busy
  // A conflicted block is frozen, and the band seated above it is the gesture that thaws it: 用我的
  // clears the flag through `resolveConflict`, this set stops naming the block, and the same caret,
  // IME and ribbon that write every other paragraph write the merge.
  const conflicts = new Set(edits.filter(edit => edit.conflicted === true).map(edit => edit.nodeId))
  const writable = (block: HTMLElement): boolean => {
    const nodeId = mapping.current.get(block)
    return nodeId !== undefined && !conflicts.has(nodeId)
  }

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
    // A frozen block retains no target and no ribbon reading, so the commands stay inert while its text is still selectable.
    const frozen = blocks.some(block => !writable(block))
    target.current = frozen ? null : { range: range.cloneRange(), blocks }
    setCaret(editable && !frozen ? selectionReading(range, blocks) : null)
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
  // The page under the middle of the viewport is the one being read; the count follows the rendered pages.
  const measurePages = (): void => {
    const element = host.current
    const list = [...element?.shadowRoot?.querySelectorAll<HTMLElement>('.paperai-doc .page') ?? []]
    if (element === null || list.length === 0) { setPages(previous => previous.total === 0 ? previous : { current: 1, total: 0 }); return }
    const middle = element.getBoundingClientRect().top + element.clientHeight / 2
    let current = 0
    list.forEach((page, index) => { if (page.getBoundingClientRect().top <= middle) current = index })
    setPages(previous => (previous.current === current + 1 && previous.total === list.length
      ? previous
      : { current: current + 1, total: list.length }))
  }

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
    originals.current = new Map([...mapping.current.keys()].map(block => [block, {
      image: imageOf(block), runs: runsOf(block), effective: effectiveRunsOf(block),
    }]))
    latest.current = new Map([...mapping.current.keys()].map(block => [block, imageOf(block)]))
    history.current = { past: [], future: [] }; updateHistory(); target.current = null
    setCaret(null); setExcerpt(null)
    setFonts([...new Set([...mapping.current.keys()].flatMap(block => [block, ...block.querySelectorAll<HTMLElement>('span')])
      .map(block => fontOf(getComputedStyle(block))).filter(Boolean).concat(['宋体', '黑体', '等线', 'Times New Roman', 'Arial']))])
    setChanges({ count: container.querySelectorAll('[data-paperai-change]').length, index: 0 })
    measurePages()
  }, [html, revision])

  useLayoutEffect(() => {
    const drafts = new Map(edits.map(edit => [edit.nodeId, edit]))
    const shadow = host.current?.shadowRoot
    const container = shadow?.querySelector<HTMLElement>('.paperai-doc')
    if (editable) container?.setAttribute('contenteditable', 'true')
    else container?.removeAttribute('contenteditable')
    for (const block of shadow?.querySelectorAll<HTMLElement>('[data-paperai-block], [data-paperai-protected]') ?? []) {
      if (editable) block.setAttribute('contenteditable', writable(block) ? 'true' : 'false')
      else block.removeAttribute('contenteditable')
    }
    const focused = shadow?.activeElement
    const focusNode = focused === container ? rangeNow()?.startContainer : focused
    for (const [block, nodeId] of mapping.current) {
      // Blocks are matched to head nodes by text, so on a compared page a head draft would paint into
      // another version's paragraph and then wear the same mark as that version's own changes.
      // ponytail: the mapping still names head nodes, so quoting a compared page hands the Agent head
      // ids; name the version's own nodes once the diff carries its node index.
      const edit = comparing ? undefined : drafts.get(nodeId)
      const original = originals.current.get(block)
      if (active && edit !== undefined && edit.conflicted !== true && edit.baseRevision !== revision
        && edit.formatting !== undefined && original !== undefined && !sameRuns(edit.formatting.before, original.effective)) {
        conflicts.add(nodeId)
        block.setAttribute('contenteditable', 'false')
        callbacks.current.onDraft(nodeId, { ...edit, text: edit.draft, conflicted: true })
      }
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
      block.toggleAttribute('data-paperai-conflicted', conflicts.has(nodeId))
      latest.current.set(block, imageOf(block))
    }
    // ── The other side of each conflict, seated above the paragraph it contests ──────────────────
    // Keyed by node id, so this is idempotent: a conflicted draft cannot change (`updateDraft` refuses
    // one), and the document's text changes only with `html`, whose effect rebuilds the shadow root.
    // So no word diff runs on an unrelated keystroke.
    const seated = new Map([...container?.querySelectorAll<HTMLElement>('[data-paperai-conflict]') ?? []]
      .map(band => [band.dataset.paperaiConflict, band] as const))
    for (const [nodeId, band] of seated) {
      if (!comparing && nodeId !== undefined && conflicts.has(nodeId as PaperAIDocumentNodeId)) continue
      seated.delete(nodeId)
      // By node id, not by the band's next sibling: a band whose paragraph sits in a table cell stands
      // before the whole table, so the sibling is the table and the paragraph would keep its rule.
      for (const seat of container?.querySelectorAll<HTMLElement>('[data-paperai-conflict-seat]') ?? []) {
        if (seat.dataset.paperaiNode === nodeId) delete seat.dataset.paperaiConflictSeat
      }
      // Removed outright rather than collapsed: every exit follows a press on this band's own button,
      // so it is direct feedback, not a block vanishing unbidden above a live caret.
      band.remove()
    }
    for (const edit of comparing ? [] : edits) {
      if (!conflicts.has(edit.nodeId) || seated.has(edit.nodeId)) continue
      const mapped = [...mapping.current].find(([, id]) => id === edit.nodeId)?.[0]
      // Matched in JS rather than through an attribute selector: a node id is an opaque Host string,
      // and CSS.escape is absent outside a browser, so a selector would make this path environment-bound.
      const seat = mapped ?? [...container?.querySelectorAll<HTMLElement>('[data-paperai-node]') ?? []]
        .find(candidate => candidate.dataset.paperaiNode === edit.nodeId)
      // A paragraph out of `mapping` takes no keystrokes, so its band quotes the draft for saving by
      // hand instead of offering a merge; the paragraph itself is already showing the document.
      const form = mapped === undefined ? 'draft' : 'document'
      const band = conflictBand(document, {
        nodeId: edit.nodeId,
        form,
        theirs: nodes.find(node => node.nodeId === edit.nodeId)?.text ?? edit.baseText,
        mine: edit.draft,
        copy: bandCopy(form, t),
      })
      if (seat !== undefined) seat.dataset.paperaiConflictSeat = form === 'draft' ? 'theirs' : 'mine'
      // A band never enters a table: it stands before the table its seat sits in, as a removed
      // paragraph's placeholder already does on a compared page.
      if (seat === undefined) container?.append(band)
      else (seat.closest('table') ?? seat).before(band)
      // Next frame, so the row and the opacity have an initial style to transition from and the
      // thesis is pushed down rather than jumped.
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { band.dataset.paperaiOpen = '' })
      else band.dataset.paperaiOpen = ''
    }
    // The caret reading survives the conflict; only a selection inside a frozen block clears it, in capture.
    if (conflicted) setNotice('editor.conflict')
    // `editable` carries the flag already, but not while saving, busy, or conflicted: the drafts still
    // have to come back when the comparison closes.
  }, [active, comparing, edits, editable, html, nodes, revision])
  useLayoutEffect(() => { if (active && host.current !== null) host.current.scrollTop = scrollTop }, [active, html])
  // The pill leaves with the last draft while this component stays mounted: a half-pressed discard must not greet the next draft.
  useEffect(() => { if (edits.length === 0) setConfirmDiscard(false) }, [edits.length])
  // The bar stays inside the stage: clamped sideways, and flipped above the selection when the room below runs out.
  useLayoutEffect(() => {
    const element = barRef.current
    const stage = host.current?.parentElement
    if (element === null || bar === null || stage === null || stage === undefined) return
    const half = element.offsetWidth / 2
    element.style.left = `${Math.min(Math.max(bar.x, half + 8), Math.max(half + 8, stage.clientWidth - half - 8))}px`
    element.style.top = `${bar.y + 8 + element.offsetHeight <= stage.clientHeight ? bar.y + 8 : bar.above - 8 - element.offsetHeight}px`
  }, [bar])
  // An outline click names a block: the page brings it under the top edge, and the scroll that follows records the offset.
  useLayoutEffect(() => {
    const element = host.current
    if (!active || reveal === null || element === null) return
    const wanted = normalize(nodes.find(node => node.nodeId === reveal.nodeId)?.text ?? '')
    const block = [...mapping.current].find(([, id]) => id === reveal.nodeId)?.[0]
      ?? (wanted === '' ? undefined : [...element.shadowRoot?.querySelectorAll<HTMLElement>('[data-path]') ?? []]
        .find(candidate => normalize(textOf(candidate)) === wanted))
    if (block !== undefined) element.scrollTop += block.getBoundingClientRect().top - element.getBoundingClientRect().top - 16
  }, [reveal])
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
      // What a control inside the page divides by to stay its own size on screen while the paper scales.
      element.style.setProperty('--paperai-page-relief', (1 / factor).toFixed(3))
      if (zoom === 'fit') setFitPercent(Math.round(factor * 100))
      measurePages()
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
        ...(structured ? { paragraphs: parts.map((part, index) => ({ ...part,
          runs: part.text === '' ? effectiveRunsOf(paragraphsOf(block)[index] as HTMLElement)
            : original === undefined ? part.runs ?? [] : restateCleared(part.runs ?? [], original.runs, block),
        })) }
          : formatted ? { runs: stating } : {}),
        ...(original !== undefined ? { formatting: {
          before: original.effective,
          after: paragraphsOf(block).flatMap((part, index) => {
            const reading = effectiveRunsOf(part)
            return index === 0 ? reading : [{ ...reading[0], text: '\n' }, ...reading]
          }),
        } } : {}),
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
  /** Put the half-pressed 放弃这段草稿 back, so the next click elsewhere cannot complete a discard. */
  const disarm = (): void => {
    const button = armed.current
    armed.current = null
    if (button === null) return
    delete button.dataset.paperaiArmed
    button.textContent = t('editor.conflictDrop')
  }
  /**
   * One press on a conflict band. Both fills route through `finish` rather than through a store
   * repaint: the repaint refuses any block holding the focus, which would silently desync the store
   * from the page, and it never enters `history`, which would make 用文档的 an unrecoverable press.
   * @param button - the button pressed, inside the band naming its block.
   */
  const resolve = (button: HTMLElement): void => {
    const band = button.closest<HTMLElement>('[data-paperai-conflict]')
    const nodeId = band?.dataset.paperaiConflict as PaperAIDocumentNodeId | undefined
    if (band === null || nodeId === undefined) return
    const kind = button.dataset.paperaiResolve
    if (kind !== 'drop') disarm()
    // The draft on an unmergeable paragraph exists nowhere but this band, so 复制 both writes the
    // clipboard and selects the quotation: where the clipboard is refused, Ctrl+C still works.
    if (kind === 'copy') {
      const quoted = band.querySelector<HTMLElement>('.paperai-conflict-text')
      if (quoted === null) return
      const range = document.createRange(); range.selectNodeContents(quoted)
      const current = selection(); current?.removeAllRanges(); current?.addRange(range)
      // lib.dom promises a clipboard that an insecure context does not have, where the bare call
      // throws and would take the selection down with it. The selection is the guarantee; this is
      // the convenience on top of it.
      const clipboard = navigator.clipboard as Clipboard | undefined
      if (clipboard !== undefined) void clipboard.writeText(quoted.textContent).catch(() => undefined)
      return
    }
    // Saving, comparing or busy: the snapshot a commit takes before its await must not move under it.
    if (!editable) { setNotice('editor.conflict'); return }
    if (kind === 'drop') {
      // This destroys text that exists nowhere else, so it asks twice.
      if (armed.current === button) { disarm(); callbacks.current.onDraft(nodeId, null); return }
      disarm()
      armed.current = button
      button.dataset.paperaiArmed = ''
      button.textContent = t('editor.conflictDropConfirm')
      return
    }
    const block = [...mapping.current].find(([, id]) => id === nodeId)?.[0]
    if (block === undefined) return
    if (kind === 'mine') {
      // Unfreeze first: `updateDraft` refuses to write a draft onto a block still marked conflicted,
      // so the report `finish` publishes would be dropped in the same tick.
      onResolveConflict?.(nodeId)
      finish([block])
      block.focus({ preventScroll: true })
      return
    }
    const original = originals.current.get(block)
    if (original === undefined) return
    // The document's text as this reload delivered it. `report` then finds the block unchanged and
    // publishes `draft: null`, so the edit drops itself and takes its conflict with it.
    restoreImage(original.image)
    finish([block])
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
    if (block !== undefined && !writable(block)) { setNotice('editor.conflict'); return }
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
      if (block !== undefined && !writable(block)) { event.preventDefault(); setNotice('editor.conflict'); return }
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
        if (atEdge && edge.toString() === '' && edge.cloneContents().querySelector('br:not([data-paperai-placeholder])') === null) {
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
        // Escape restores the document's text; in a frozen block that would silently drop the draft it retains for copying.
        if (original !== undefined && editable && writable(block)) { restoreImage(original.image); finish([block]); block.blur() }
      }
    }
    const compositionStart = (event: Event): void => {
      composing.current = true
      compositionBlock.current = blockOf(event) ?? null
      const range = rangeNow()
      const inside = range === null ? undefined : [...mapping.current.keys()]
        .find(block => block.contains(range.startContainer) && block.contains(range.endContainer))
      if (range !== null && (inside === undefined || !writable(inside))) {
        blockedComposition.current = compositionSnapshot(container)
        setNotice(inside === undefined ? 'editor.structureProtected' : 'editor.conflict')
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
    // Selected text in mapped blocks gets the selection menu instead of the browser's; anything else keeps the native one.
    const contextMenu = (event: Event): void => {
      if (!(event instanceof MouseEvent) || onQuote === undefined) return
      const range = rangeNow()
      if (range === null || range.collapsed || range.toString().trim() === '' || ![...mapping.current.keys()].some(block => range.intersectsNode(block))) return
      event.preventDefault(); capture(range); setContext({ x: event.clientX, y: event.clientY }); setBar(null)
    }
    const clicked = (event: Event): void => {
      const button = event.composedPath().find((node): node is HTMLElement =>
        node instanceof HTMLElement && node.dataset.paperaiResolve !== undefined)
      if (button !== undefined) { resolve(button); return }
      disarm()
      if (event.composedPath().some(node => node instanceof HTMLElement && node.dataset.paperaiProtected !== undefined)) setNotice('editor.protected')
      else if (!conflicted) setNotice(null)
      capture()
    }
    // A selection still changing hides the bar; one that settles (key or mouse released) over mapped text shows it under its last line.
    const changed = (): void => { if (!composing.current) capture(); setBar(null) }
    const settled = (): void => {
      if (composing.current) return
      capture()
      const range = rangeNow()
      const stage = host.current?.parentElement
      if (range === null || range.collapsed || range.toString().trim() === '' || stage === null || stage === undefined
        || ![...mapping.current.keys()].some(block => range.intersectsNode(block))) { setBar(null); return }
      // jsdom's Range has no rect; the bar then sits at the stage origin, which the tests never look at.
      const rect = (range as Partial<Range>).getBoundingClientRect?.() ?? { left: 0, width: 0, top: 0, bottom: 0 }
      const base = stage.getBoundingClientRect()
      setBar({ x: rect.left + rect.width / 2 - base.left, y: rect.bottom - base.top, above: rect.top - base.top })
    }
    const listeners: readonly [string, EventListener][] = [['input', input], ['beforeinput', beforeInput], ['paste', paste], ['keydown', keyDown],
      ['compositionstart', compositionStart], ['compositionend', compositionEnd], ['click', clicked], ['contextmenu', contextMenu], ['keyup', settled], ['mouseup', settled]]
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
  const zoomStep = (direction: 1 | -1): number | undefined => {
    const current = zoom === 'fit' ? fitPercent : zoom
    return direction > 0 ? ZOOMS.find(value => value > current) : [...ZOOMS].reverse().find(value => value < current)
  }
  const goToChange = (step: number): void => {
    const marked = [...host.current?.shadowRoot?.querySelectorAll<HTMLElement>('[data-paperai-change]') ?? []]
    if (marked.length === 0) return
    const index = (changes.index + step + marked.length) % marked.length
    marked.forEach((block, position) => block.toggleAttribute('data-paperai-current', position === index))
    marked[index]?.scrollIntoView({ block: 'center' }); setChanges({ count: marked.length, index })
  }
  /** Hand the captured selection to the Agent with an optional canned request, and put the selection surfaces away. */
  const act = (request?: string): void => {
    if (excerpt !== null && onQuote !== undefined) onQuote(excerpt, request)
    setExcerpt(null); setBar(null); setContext(null)
  }
  const requestFor = (id: string): string | undefined => {
    const key = SELECTION_REQUESTS.find(([action]) => action === id)?.[2]
    return key === undefined ? undefined : t(key)
  }
  return (
    <div className={css.previewSeat} hidden={!active} aria-hidden={!active || undefined}>
      {active && !comparing && <EditorRibbon caret={caret} fonts={fonts} paragraphStyles={paragraphStyles}
        disabled={!editable || composing.current}
        undo={historyState.undo} redo={historyState.redo} onUndo={() =>{  undo() }} onRedo={() =>{  undo(true) }}
        onToggle={toggle} onFormat={format} onParagraph={paragraph} onFind={find}
        onClear={() =>{  format({ 'font-weight': '', 'font-style': '', 'text-decoration': '', 'font-size': '', 'font-family': '', color: '' }) }} t={t} />}
      {active && notice !== null && <div className={css.notice} role="status">{t(notice)}</div>}
      {active && context !== null && onQuote !== undefined && <Menu portal compact open
        items={[{ id: 'ask', label: t('selection.ask') }, { type: 'separator', id: 'canned' },
          ...SELECTION_REQUESTS.map(([id, label]) => ({ id, label: t(label) }))]} anchor={<span hidden />}
        getAnchorRect={() => ({ left: context.x, right: context.x, top: context.y, bottom: context.y, width: 0, height: 0 } as DOMRect)}
        onSelect={(id) => { act(requestFor(id)) }}
        onClose={() => { setContext(null) }} />}
      <div className={css.stage}>
        <div ref={host} className={css.preview} role="document" aria-label={title}
          onScroll={(event) => { if (active) onScroll?.(event.currentTarget.scrollTop); measurePages(); setBar(null) }} />
        {active && bar !== null && excerpt !== null && onQuote !== undefined && (
          <div ref={barRef} className={clsx(css.floating, css.selectionBar)} role="toolbar" aria-label={t('selection.title')}
            style={{ left: bar.x, top: bar.y + 8 }} onMouseDown={(event) => { event.preventDefault() }}>
            <button type="button" onClick={() => { act() }}>{t('selection.ask')}</button>
            {SELECTION_REQUESTS.map(([id, label, request]) => (
              <button key={id} type="button" onClick={() => { act(t(request)) }}>{t(label)}</button>
            ))}
          </div>
        )}
        {active && pages.total > 0 && <div className={clsx(css.floating, css.pageCounter)} aria-label={t('status.page', pages)} title={t('status.pagination')}>
          {pages.current} / {pages.total}
        </div>}
        {active && onZoom !== undefined && <div className={clsx(css.floating, css.zoomPill)} role="group" aria-label={t('status.zoom')}>
          <button type="button" aria-label={t('status.zoomOut')} title={t('status.zoomOut')} disabled={zoomStep(-1) === undefined}
            onClick={() => { const next = zoomStep(-1); if (next !== undefined) onZoom(next) }}><IconZoomOut size={14} /></button>
          <Menu portal dense align="end" open={zoomOpen} selectedId={String(zoom)}
            items={[{ id: 'fit', label: t('status.fit') }, ...ZOOMS.map(value => ({ id: String(value), label: `${value}%` }))]}
            anchor={<button type="button" aria-haspopup="menu" aria-expanded={zoomOpen} aria-label={t('status.zoom')}
              title={`${zoom === 'fit' ? t('status.fit') : t('status.zoom')} · ${t('status.pagination')}`}
              onClick={() => { setZoomOpen(open => !open) }}>{zoom === 'fit' ? fitPercent : zoom}%</button>}
            onSelect={(id) => { setZoomOpen(false); onZoom(id === 'fit' ? 'fit' : Number(id)) }} onClose={() => { setZoomOpen(false) }} />
          <button type="button" aria-label={t('status.zoomIn')} title={t('status.zoomIn')} disabled={zoomStep(1) === undefined}
            onClick={() => { const next = zoomStep(1); if (next !== undefined) onZoom(next) }}><IconPlusOutline16 size={14} /></button>
        </div>}
        {active && comparing && changes.count > 0 && <div className={clsx(css.floating, css.changeNav)} role="group" aria-label={t('versions.changes')}>
          <span>{t('versions.changeNav', { index: changes.index + 1, count: changes.count })}</span>
          <button type="button" aria-label={t('versions.prev')} onClick={() =>{  goToChange(-1) }}><IconChevronDownOutline14 className={css.flipped ?? ''} /></button>
          <button type="button" aria-label={t('versions.next')} onClick={() =>{  goToChange(1) }}><IconChevronDownOutline14 /></button>
        </div>}
        {active && edits.length > 0 && <div className={clsx(css.floating, css.pending)} role="group" aria-label={t('block.pending', { count: edits.length })} data-paperai-pending>
          <span>{t('block.pending', { count: edits.length })}</span>
          <span className={css.pendingNote}>{t('status.memory')}</span>
          {conflicted && <span role="alert">{t('block.conflicted')}</span>}
          {saveFailed && <span role="alert">{t('block.saveFailed')}</span>}
          {confirmDiscard
            ? <>
              <button className={css.chip} type="button" disabled={comparing || saving || busy} onClick={() => {
                for (const original of originals.current.values()) restoreImage(original.image)
                history.current = { past: [], future: [] }; updateHistory(); onCancel()
              }}>{t('block.confirmDiscard')}</button>
              <button className={css.chip} type="button" onClick={() => { setConfirmDiscard(false) }}>{t('block.cancelDiscard')}</button>
            </>
            // The drafts and the undo stack go together and live only in this browser, so the first press only asks.
            : <button className={css.chip} type="button" disabled={comparing || saving || busy}
              onClick={() => { setConfirmDiscard(true) }}>{t('block.discard')}</button>}
          <button className={css.chip} type="button" data-kind="save" disabled={comparing || saving || busy || !edits.some(edit => edit.conflicted !== true)} onClick={onSave}>{saving ? t('block.saving') : t('block.save')}</button>
        </div>}
      </div>
    </div>
  )
}
