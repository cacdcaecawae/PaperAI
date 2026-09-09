/** Block-level reading of the Host's preview HTML: the rendered preview, the commit patch, and the version diff. */

import type { PaperAIVersionChange } from './types.ts'

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

/** One committed text replacement, keyed by the text the block showed before and whether it is a table cell. */
export interface PreviewTextPatch {
  readonly baseText: string
  readonly nextText: string
  readonly cell: boolean
}

/**
 * Write committed block texts into the preview the browser already shows, so a
 * commit paints at once while the Host renders the authoritative preview. Like
 * block editing, only provider-addressed blocks take part, and a cell never
 * stands in for a body paragraph with the same text (nor the reverse).
 * ponytail: the first such block wins when texts repeat inside one kind; the Host preview that follows corrects it.
 * @param html - preview currently on screen.
 * @param patches - committed replacements in commit order.
 * @returns the preview with matching blocks retyped; run formatting inside them flattens until the refresh.
 */
export function patchPreviewHtml(html: string, patches: readonly PreviewTextPatch[]): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const blocks = blocksOf(parsed.body)
  for (const { baseText, nextText, cell } of patches) {
    const block = blocks.find(candidate => (
      candidate.dataset.path !== undefined
      && (candidate.closest('td, th') !== null) === cell
      && normalize(candidate.textContent) === normalize(baseText)
    ))
    if (block !== undefined) block.textContent = nextText
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
 * Show a version's changes on the current preview: blocks still carrying the
 * changed or added text get their words marked, and a removed paragraph
 * reappears struck through after the previous marked block. Changes the
 * current text no longer carries are returned unplaced for the panel to list.
 * Every marked block carries `data-paperai-change`.
 * ponytail: the Host diff carries no positions, so a removed paragraph follows the previous change and leads nothing.
 * @param html - preview of the current document.
 * @param changes - the version's paragraph changes in reading order.
 * @returns the marked preview and the changes it could not place.
 */
export function markDiffHtml(html: string, changes: readonly PaperAIVersionChange[]): MarkedDiff {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const blocks = blocksOf(parsed.body)
  const unplaced: PaperAIVersionChange[] = []
  let anchor: HTMLElement | null = null
  for (const change of changes) {
    const after = change.after
    const block = after === undefined
      ? undefined
      : blocks.find(candidate => candidate.dataset.paperaiChange === undefined && normalize(candidate.textContent) === normalize(after))
    if (block !== undefined) {
      block.replaceChildren(...wordDiff(change.before ?? '', after ?? '').map(([kind, text]) => (
        kind === 'same' ? parsed.createTextNode(text) : run(parsed, kind, text)
      )))
      block.dataset.paperaiChange = ''
      anchor = block
    } else if (after === undefined && anchor !== null) {
      const removed = parsed.createElement('p')
      removed.append(run(parsed, 'del', change.before ?? ''))
      anchor.after(removed)
      removed.dataset.paperaiChange = ''
      anchor = removed
    } else {
      unplaced.push(change)
    }
  }
  return { html: parsed.documentElement.outerHTML, unplaced }
}
