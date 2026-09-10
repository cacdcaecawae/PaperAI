/** Block-level reading of the Host's preview HTML: the rendered preview, the commit patch, and the version diff. */

import type { PaperAIDocumentTextRun, PaperAIVersionChange } from './types.ts'

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

/**
 * Whether a rendered element reads underlined, from either the longhand or the shorthand.
 * @param style - resolved style of a block or one of its runs.
 * @returns whether Word would store the run as underlined.
 */
export function underlineOf(style: CSSStyleDeclaration): boolean {
  return `${style.textDecorationLine} ${style.textDecoration}`.includes('underline')
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
function overridesOf(run: CSSStyleDeclaration, block: CSSStyleDeclaration): Omit<PaperAIDocumentTextRun, 'text'> {
  const bold = boldOf(run)
  const italic = run.fontStyle === 'italic'
  const underline = underlineOf(run)
  const size = pointsOf(run)
  return {
    ...(bold === boldOf(block) ? {} : { bold }),
    ...(italic === (block.fontStyle === 'italic') ? {} : { italic }),
    ...(underline === underlineOf(block) ? {} : { underline }),
    ...(!Number.isFinite(size) || size === pointsOf(block) ? {} : { size: `${size}pt` }),
    ...(run.color === block.color ? {} : { color: hexOf(run.color) }),
  }
}

/** Two runs carry the same formatting when every stated override matches. */
function sameFormat(left: PaperAIDocumentTextRun, right: PaperAIDocumentTextRun): boolean {
  return (['bold', 'italic', 'underline', 'size', 'color'] as const).every(key => left[key] === right[key])
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
 * character formatting changes, each run stating only what it overrides. Runs
 * that read alike merge, so an unformatted block is one run and a commit for it
 * stays one engine operation.
 * @param block - rendered block, attached to a document so its style resolves.
 * @returns the block's runs in reading order.
 */
export function runsOf(block: HTMLElement): PaperAIDocumentTextRun[] {
  const view = block.ownerDocument.defaultView
  if (view === null) return [{ text: block.textContent }]
  const base = view.getComputedStyle(block)
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const runs: PaperAIDocumentTextRun[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue ?? ''
    const parent = node.parentElement
    if (text === '' || parent === null) continue
    const run = { text, ...(parent === block ? {} : overridesOf(view.getComputedStyle(parent), base)) }
    const last = runs.at(-1)
    if (last !== undefined && sameFormat(last, run)) runs[runs.length - 1] = { ...last, text: last.text + text }
    else runs.push(run)
  }
  return runs
}

/**
 * Write runs into a block as spans carrying their overrides. The rendered
 * preview from the Host replaces this shortly after a commit; until it arrives
 * a rebuilt run shows in the block's own typeface rather than its original one.
 * @param block - block whose contents are replaced.
 * @param runs - runs in reading order.
 */
export function applyRuns(block: HTMLElement, runs: readonly PaperAIDocumentTextRun[]): void {
  block.replaceChildren(...runs.map((run) => {
    const span = block.ownerDocument.createElement('span')
    if (run.bold !== undefined) span.style.fontWeight = run.bold ? 'bold' : 'normal'
    if (run.italic !== undefined) span.style.fontStyle = run.italic ? 'italic' : 'normal'
    if (run.underline !== undefined) span.style.textDecoration = run.underline ? 'underline' : 'none'
    if (run.size !== undefined) span.style.fontSize = run.size
    if (run.color !== undefined) span.style.color = run.color
    span.textContent = run.text
    return span
  }))
}

/** Provider-addressed blocks whose text matches, in reading order; page bands without an address never take part. */
function addressed(blocks: readonly HTMLElement[], text: string): HTMLElement[] {
  const wanted = normalize(text)
  return blocks.filter(block => block.dataset.path !== undefined && normalize(block.textContent) === wanted)
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
    if (patch.runs === undefined) block.textContent = patch.nextText
    else applyRuns(block, patch.runs)
  }
  return parsed.documentElement.outerHTML
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
