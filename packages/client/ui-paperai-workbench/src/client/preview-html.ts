/** Block-level reading of the Host's preview HTML: the rendered preview, the commit patch, and the version diff. */

import type { PaperAIDocumentTextRun, PaperAIVersionChange, PaperAIDocumentParagraph, PaperAIParagraphFormat } from './types.ts'

/** Tags whose text maps back to one semantic node. */
export const BLOCK_TAGS = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH']

/**
 * Collapse whitespace so preview text and node text compare equal.
 * @param text - block or node text as rendered or stored.
 * @returns the text with runs of whitespace folded to one space and the ends trimmed.
 */
export function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Read preview text with Word's soft-break marker rather than dropping HTML breaks.
 * @param block - one preview paragraph.
 * @returns its complete text, including vertical-tab soft breaks.
 */
export function textOf(block: HTMLElement): string {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  let text = ''
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    text += node instanceof Element ? (node.tagName === 'BR' && !node.hasAttribute('data-paperai-placeholder') ? '\v' : '') : node.nodeValue ?? ''
  }
  return text
}

/**
 * Every text block of the rendered document in reading order; cells hosting paragraphs defer to them.
 * @param container - element holding the rendered preview.
 * @returns paragraphs, headings, list items, and leaf cells in document order.
 */
export function blocksOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(BLOCK_TAGS.join(','))]
    .filter(element => !((element.tagName === 'TD' || element.tagName === 'TH') && element.querySelector('p') !== null))
}

/** Word stores font sizes in points; the preview renders one point as 4/3 of a CSS pixel. */
const PIXELS_PER_POINT = 4 / 3

/**
 * Whether a rendered element reads bold, so 'bold' and a numeric weight agree.
 * @param style - resolved style of a block or one of its runs.
 * @returns whether Word would store the run as bold.
 */
export function boldOf(style: CSSStyleDeclaration): boolean {
  const weight = style.fontWeight
  return weight === 'bold' || Number(weight) >= 600
}

/** Whether a resolved style states an underline, from either the longhand or the shorthand. */
function underlineOf(style: CSSStyleDeclaration): boolean {
  return `${style.textDecorationLine} ${style.textDecoration}`.includes('underline')
}

/**
 * Whether a rendered element reads underlined. Text decoration draws onto
 * descendants without inheriting, so an underline stated on a span above the
 * run is invisible to the run's own style and has to be looked for.
 * @param element - run element, or the block itself for its own reading.
 * @param block - block the search stops at.
 * @returns whether Word would store the text as underlined.
 */
export function underlinedWithin(element: Element, block: HTMLElement): boolean {
  const view = block.ownerDocument.defaultView
  if (view === null) return false
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (underlineOf(view.getComputedStyle(node))) return true
    if (node === block) break
  }
  return false
}

/**
 * Rendered font size in points, rounded to the half point Word offers.
 * @param style - resolved style of a block or one of its runs.
 * @returns the size in points, or NaN when the style states none.
 */
export function pointsOf(style: CSSStyleDeclaration): number {
  const value = parseFloat(style.fontSize)
  return Math.round((style.fontSize.endsWith('pt') ? value : value / PIXELS_PER_POINT) * 2) / 2
}

/** Rendered color as the '#RRGGBB' Word stores, or the value itself when it is not an rgb() triple. */
function hexOf(color: string): string {
  const channels = /^rgba?\((?<r>\d+),\s*(?<g>\d+),\s*(?<b>\d+)/u.exec(color)?.groups
  if (channels === undefined) return color
  return `#${['r', 'g', 'b'].map(key => Number(channels[key]).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

/** The character formatting one run states over its block's own; matching the block states nothing. */
function overridesOf(element: Element, block: HTMLElement, base: CSSStyleDeclaration): Omit<PaperAIDocumentTextRun, 'text'> {
  const view = block.ownerDocument.defaultView
  if (view === null) return {}
  const run = view.getComputedStyle(element)
  const bold = boldOf(run)
  const italic = run.fontStyle === 'italic'
  const underline = underlinedWithin(element, block)
  const size = pointsOf(run)
  return {
    ...(bold === boldOf(base) ? {} : { bold }),
    ...(italic === (base.fontStyle === 'italic') ? {} : { italic }),
    ...(underline === underlinedWithin(block, block) ? {} : { underline }),
    ...(!Number.isFinite(size) || size === pointsOf(base) ? {} : { size: `${size}pt` }),
    ...(run.color === base.color ? {} : { color: hexOf(run.color) }),
    ...(run.fontFamily === base.fontFamily ? {} : { font: fontOf(run) }),
  }
}

/** Two runs carry the same formatting when every stated override matches. */
function sameFormat(left: PaperAIDocumentTextRun, right: PaperAIDocumentTextRun): boolean {
  return (['bold', 'italic', 'underline', 'size', 'color', 'font'] as const).every(key => left[key] === right[key])
}

/**
 * The first named font family, excluding browser and CSS generic defaults.
 * @param style - resolved character style.
 * @returns the primary font family, or empty when the preview has no document font.
 */
export function fontOf(style: CSSStyleDeclaration): string {
  const family = style.fontFamily.split(',')[0]?.trim().replace(/^["']|["']$/gu, '') ?? ''
  const generic = /^(?:-apple-system|BlinkMacSystemFont|system-ui|serif|sans-serif|monospace|cursive|fantasy|emoji|math|fangsong|ui-.+)$/iu
  return generic.test(family)
    ? '' : family
}

/**
 * Compare two run lists, so a block that reads as the document has it drops its draft.
 * @param left - runs to compare.
 * @param right - runs to compare against.
 * @returns whether both spell the same text with the same formatting.
 */
export function sameRuns(left: readonly PaperAIDocumentTextRun[], right: readonly PaperAIDocumentTextRun[]): boolean {
  return left.length === right.length
    && left.every((run, index) => run.text === right[index]?.text && sameFormat(run, right[index]))
}

/**
 * Read one rendered block as the runs Word stores: its text split where the
 * character formatting changes, each run stating only what it overrides.
 * Adjacent text with matching formatting merges into one run.
 * @param block - rendered block, attached to a document so its style resolves.
 * @returns the block's runs in reading order.
 */
export function runsOf(block: HTMLElement): PaperAIDocumentTextRun[] {
  const view = block.ownerDocument.defaultView
  if (view === null) return [{ text: textOf(block) }]
  const base = view.getComputedStyle(block)
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  const runs: PaperAIDocumentTextRun[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node instanceof Element ? (node.tagName === 'BR' && !node.hasAttribute('data-paperai-placeholder') ? '\v' : '') : node.nodeValue ?? ''
    const parent = node.parentElement
    if (text === '' || parent === null) continue
    const run = { text, ...(parent === block ? {} : overridesOf(parent, block, base)) }
    const last = runs.at(-1)
    if (last !== undefined && sameFormat(last, run)) runs[runs.length - 1] = { ...last, text: last.text + text }
    else runs.push(run)
  }
  return runs
}

/**
 * The block's own character formatting, stated absolutely.
 * @param block - rendered block, attached to a document so its style resolves.
 * @returns what every property of the block reads as.
 */
function readingOf(block: HTMLElement): Required<Omit<PaperAIDocumentTextRun, 'text'>> {
  const view = block.ownerDocument.defaultView
  const style = view === null ? null : view.getComputedStyle(block)
  const size = style === null ? Number.NaN : pointsOf(style)
  return {
    bold: style !== null && boldOf(style),
    italic: style?.fontStyle === 'italic',
    underline: style !== null && underlinedWithin(block, block),
    size: Number.isFinite(size) ? `${size}pt` : '',
    color: style === null ? '' : hexOf(style.color),
    font: style === null ? '' : fontOf(style),
  }
}

/**
 * Read effective formatting for comparison without converting inherited values into Word overrides.
 * @param block - attached rendered paragraph, including an empty insertion paragraph.
 * @returns absolute character readings, with one empty seed when the paragraph has no text.
 */
export function effectiveRunsOf(block: HTMLElement): PaperAIDocumentTextRun[] {
  const own = readingOf(block)
  const runs = runsOf(block)
  if (runs.length > 0) return runs.map(run => ({ ...own, ...run }))
  const seed = block.querySelector('br[data-paperai-placeholder]')?.parentElement
    ?? [...block.querySelectorAll('span')].at(-1) ?? block
  const view = block.ownerDocument.defaultView
  return [{ text: '', ...own, ...(view === null ? {} : overridesOf(seed, block, view.getComputedStyle(block))) }]
}

/**
 * Restate resolved properties when span changes would otherwise lose the draft's displayed formatting.
 * @param runs - the block's runs as it reads now.
 * @param previous - original rendered runs.
 * @param block - the block, whose own reading replaces what is no longer stated.
 * @returns complete local render runs; commitFormatting separately selects changed Word properties.
 */
export function restateCleared(
  runs: readonly PaperAIDocumentTextRun[],
  previous: readonly PaperAIDocumentTextRun[],
  block: HTMLElement,
): PaperAIDocumentTextRun[] {
  if (runs.length === 0 || previous.length === 0) return [...runs]
  const stated = new Set(previous.flatMap(run => Object.keys(run)))
  const own = readingOf(block)
  return runs.map(run => ({
    ...run,
    ...(stated.has('bold') && run.bold === undefined ? { bold: own.bold } : {}),
    ...(stated.has('italic') && run.italic === undefined ? { italic: own.italic } : {}),
    ...(stated.has('underline') && run.underline === undefined ? { underline: own.underline } : {}),
    ...(stated.has('size') && run.size === undefined && own.size !== '' ? { size: own.size } : {}),
    ...(stated.has('color') && run.color === undefined && own.color !== '' ? { color: own.color } : {}),
    ...(stated.has('font') && run.font === undefined ? { font: own.font } : {}),
  }))
}

/**
 * Write run text, explicit formatting, and soft breaks into browser spans.
 * @param block - block whose contents are replaced.
 * @param runs - runs in reading order.
 */
export function applyRuns(block: HTMLElement, runs: readonly PaperAIDocumentTextRun[]): void {
  const empty = runs.every(run => run.text === '')
  block.replaceChildren(...runs.map((run, position) => {
    const span = block.ownerDocument.createElement('span')
    if (run.bold !== undefined) span.style.fontWeight = run.bold ? 'bold' : 'normal'
    if (run.italic !== undefined) span.style.fontStyle = run.italic ? 'italic' : 'normal'
    if (run.underline !== undefined) span.style.textDecoration = run.underline ? 'underline' : 'none'
    if (run.size !== undefined) span.style.fontSize = run.size
    if (run.color !== undefined) span.style.color = run.color
    if (run.font !== undefined) span.style.fontFamily = run.font
    run.text.split('\v').forEach((text, index) => {
      if (index > 0) span.append(block.ownerDocument.createElement('br'))
      span.append(block.ownerDocument.createTextNode(text))
    })
    if (empty && position === runs.length - 1) {
      const placeholder = block.ownerDocument.createElement('br')
      placeholder.dataset.paperaiPlaceholder = ''
      span.append(placeholder)
    }
    return span
  }))
}

/** Provider-addressed blocks whose text matches, in reading order; page bands without an address never take part. */
function addressed(blocks: readonly HTMLElement[], text: string): HTMLElement[] {
  const wanted = normalize(text)
  return blocks.filter(block => block.dataset.path !== undefined && normalize(textOf(block)) === wanted)
}

/**
 * One committed text replacement, keyed the way the editor maps blocks to
 * nodes: the text the block showed, whether it is a table cell, and which of
 * the same-text nodes of that kind it is, in reading order.
 */
export interface PreviewTextPatch {
  readonly baseText: string
  readonly nextText: string
  /** The block's runs, when its character formatting was part of the commit. */
  readonly runs?: readonly PaperAIDocumentTextRun[]
  readonly paragraphs?: readonly PaperAIDocumentParagraph[]
  readonly cell: boolean
  readonly ordinal: number
}

/**
 * Write committed block texts into the preview the browser already shows, so a
 * commit paints at once while the Host renders the authoritative preview. The
 * block is found exactly as the editor maps it: among addressed blocks of the
 * same kind with the same text, the one at the node's ordinal. A block the
 * mapping cannot name stays as it was until the rendered preview arrives.
 * @param html - preview currently on screen.
 * @param patches - committed replacements in commit order.
 * @returns the preview with matching blocks retyped; run formatting inside them flattens until the refresh.
 */
export function patchPreviewHtml(html: string, patches: readonly PreviewTextPatch[]): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const blocks = blocksOf(parsed.body)
  // Every block is located against the text the edits started from before any of them is rewritten.
  const located = patches.map(patch => [patch, addressed(blocks, patch.baseText)
    .filter(candidate => (candidate.closest('td, th') !== null) === patch.cell)[patch.ordinal]] as const)
  for (const [patch, block] of located) {
    if (block === undefined) continue
    if (patch.paragraphs !== undefined) applyParagraphs(block, patch.paragraphs)
    else if (patch.runs === undefined) applyRuns(block, [{ text: patch.nextText }])
    else applyRuns(block, patch.runs)
  }
  return parsed.documentElement.outerHTML
}

/**
 * Read draft paragraph containers, or the original block before its first split.
 * @param block - mapped original paragraph.
 * @returns draft paragraphs in reading order.
 */
export function paragraphsOf(block: HTMLElement): HTMLElement[] {
  const parts = [...block.children].filter((child): child is HTMLElement =>
    child instanceof HTMLElement && child.dataset.paperaiParagraph !== undefined)
  return parts.length === 0 ? [block] : parts
}

/**
 * Apply supported paragraph declarations and retain their explicit values for DOCX submission.
 * @param block - original or draft paragraph.
 * @param patch - explicit paragraph settings.
 */
export function applyParagraphFormat(block: HTMLElement, patch: PaperAIParagraphFormat): void {
  const previous = paragraphFormatOf(block)
  const format = { ...previous, ...patch }
  block.dataset.paperaiFormat = JSON.stringify(format)
  if (format.align !== undefined) block.style.textAlign = format.align
  if (format.indent !== undefined) block.style.marginLeft = format.indent
  if (format.lineSpacing !== undefined) block.style.lineHeight = format.lineSpacing.replace(/x$/u, '')
}

/**
 * Read explicit draft paragraph settings.
 * @param block - original or draft paragraph.
 * @returns only settings selected in the editor.
 */
export function paragraphFormatOf(block: HTMLElement): PaperAIParagraphFormat | undefined {
  const raw = block.dataset.paperaiFormat
  return raw === undefined ? undefined : JSON.parse(raw) as PaperAIParagraphFormat
}

/**
 * Paint one original block's replacement paragraphs until the DOCX preview arrives.
 * @param block - original mapped block.
 * @param paragraphs - draft paragraphs, including the original first paragraph.
 */
export function applyParagraphs(block: HTMLElement, paragraphs: readonly PaperAIDocumentParagraph[]): void {
  block.replaceChildren(...paragraphs.map((paragraph) => {
    const part = block.ownerDocument.createElement('div')
    part.dataset.paperaiParagraph = ''
    applyRuns(part, paragraph.runs ?? [{ text: paragraph.text }])
    if (paragraph.format !== undefined) applyParagraphFormat(part, paragraph.format)
    return part
  }))
}

/** Tokens a word diff compares: CJK characters one by one, Latin words and numbers whole, whitespace and punctuation as they come. */
const TOKEN = /\p{Script=Han}|[\p{L}\p{N}]+|\s+|[^\p{L}\p{N}\s]/gu

/** One run of a word diff: text kept, deleted, or inserted. */
export type DiffRun = readonly [kind: 'same' | 'del' | 'ins', text: string]

/**
 * Word-level diff of two paragraphs by longest common subsequence.
 * ponytail: an O(n·m) table; paragraph pairs beyond 250k cells fall back to one deletion and one insertion.
 * @param before - the paragraph in the parent version.
 * @param after - the paragraph in the compared version.
 * @returns runs in reading order, adjacent runs of one kind merged.
 */
export function wordDiff(before: string, after: string): DiffRun[] {
  const a = before.match(TOKEN) ?? []
  const b = after.match(TOKEN) ?? []
  if (a.length * b.length > 250_000) return [['del', before], ['ins', after]]
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? (table[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }
  const runs: [DiffRun[0], string][] = []
  const push = (kind: DiffRun[0], text: string): void => {
    const last = runs.at(-1)
    if (last?.[0] === kind) last[1] += text
    else runs.push([kind, text])
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push('same', a[i] ?? '')
      i += 1
      j += 1
    } else if (i < a.length && (j === b.length || (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))) {
      push('del', a[i] ?? '')
      i += 1
    } else {
      push('ins', b[j] ?? '')
      j += 1
    }
  }
  return runs
}

function run(document: Document, kind: 'del' | 'ins', text: string): HTMLElement {
  const element = document.createElement(kind)
  element.textContent = text
  return element
}

/** A version's changes laid over the current preview, and those the current text no longer carries. */
export interface MarkedDiff {
  readonly html: string
  readonly unplaced: readonly PaperAIVersionChange[]
}

/**
 * Show a version's changes on the current preview. A changed or added
 * paragraph is marked in place only when exactly one addressed body block
 * still carries its text; removed paragraphs, and changes whose text is gone
 * or repeated, are returned unplaced for the panel to list rather than guessed
 * at. Every marked block carries `data-paperai-change`.
 * @param html - preview of the current document.
 * @param changes - the version's paragraph changes in reading order.
 * @returns the marked preview and the changes it could not place.
 */
export function markDiffHtml(html: string, changes: readonly PaperAIVersionChange[]): MarkedDiff {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const blocks = blocksOf(parsed.body)
  const unplaced: PaperAIVersionChange[] = []
  for (const change of changes) {
    const after = change.after
    const candidates = after === undefined
      ? []
      : addressed(blocks, after).filter(candidate => candidate.dataset.paperaiChange === undefined)
    const block = candidates.length === 1 ? candidates[0] : undefined
    if (block === undefined) {
      unplaced.push(change)
      continue
    }
    block.replaceChildren(...wordDiff(change.before ?? '', after ?? '').map(([kind, text]) => (
      kind === 'same' ? parsed.createTextNode(text) : run(parsed, kind, text)
    )))
    block.dataset.paperaiChange = ''
  }
  return { html: parsed.documentElement.outerHTML, unplaced }
}
