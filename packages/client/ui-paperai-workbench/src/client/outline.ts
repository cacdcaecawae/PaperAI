/** The document outline: the Word heading styles the Host preview states, or text heuristics for a document that states none. */

import type { PaperAIDocumentNodeId, PaperAIDocumentNodeSummary, PaperAIOutlineEntry } from './types.ts'
import { blocksOf, normalize, textOf } from './preview-html.ts'

// ponytail: these heuristics only read a document with no heading style at
// all, where nothing but a chapter's own numbering can say where it starts.
// A document that states its styles never reaches them, so the false chapters
// they read out of a generated table of contents cannot reach a styled thesis.
const CHAPTER = /^第\s*[一二三四五六七八九十百零\d]+\s*[章部篇]\s*\S/u
const NUMBERED = /^(\d{1,2}(?:\.\d{1,2})*)[．.]?\s+\S/u
// 一、 and （一） are the other numbering theses use; the parenthesised form sits one level down.
const CHINESE = /^[一二三四五六七八九十]+[、．.]\s*\S/u
const CHINESE_SUB = /^[（(][一二三四五六七八九十]+[）)]\s*\S/u
const NAMED = /^(?:摘\s*要|abstract|目\s*录|参\s*考\s*文\s*献|结\s*论|致\s*谢|绪\s*论|引\s*言|附\s*录\s*[A-Z\d]*)$/iu
const MAX_LENGTH = 60

function levelOf(text: string): PaperAIOutlineEntry['level'] | null {
  if (text.length > MAX_LENGTH || /[。；;，,]$/u.test(text)) return null
  const numbered = NUMBERED.exec(text)
  if (numbered !== null) return Math.min(3, (numbered[1] ?? '').split('.').length) as PaperAIOutlineEntry['level']
  if (CHINESE_SUB.test(text)) return 2
  if (CHAPTER.test(text) || CHINESE.test(text) || NAMED.test(text)) return 1
  return null
}

/** A rendered heading tag; Word headings below the third share the outline's deepest level. */
const HEADING = /^H([1-6])$/u

/**
 * The heading level the Host preview states for each node.
 *
 * The preview renders a Word heading-styled paragraph as `h1`..`h6`, and that
 * is the only place the document's own styles reach the browser: a node
 * summary carries neither a style nor an Office path. Blocks and nodes are
 * therefore paired exactly as the editor pairs them, addressed blocks
 * consuming equal-text nodes in reading order, so an outline entry names the
 * block the editor edits. An empty block identifies no node, so it consumes
 * none; pairing one would spend a node a later heading needs.
 * @param nodes - the document's node index in reading order.
 * @param previewHtml - the Host preview of that same document.
 * @returns the level of every node the preview renders as a heading.
 */
function styledLevels(
  nodes: readonly PaperAIDocumentNodeSummary[],
  previewHtml: string,
): Map<PaperAIDocumentNodeId, PaperAIOutlineEntry['level']> {
  const levels = new Map<PaperAIDocumentNodeId, PaperAIOutlineEntry['level']>()
  if (previewHtml === '') return levels
  const candidates = nodes.filter(node => node.kind !== 'table')
    .map(node => ({ nodeId: node.nodeId, cell: node.kind === 'table-cell', text: normalize(node.text), used: false }))
  for (const block of blocksOf(new DOMParser().parseFromString(previewHtml, 'text/html').body)) {
    const text = normalize(textOf(block))
    if (block.dataset.path === undefined || text === '') continue
    const cell = block.closest('td, th') !== null
    const paired = candidates.find(candidate => !candidate.used && candidate.cell === cell && candidate.text === text)
    if (paired === undefined) continue
    paired.used = true
    const depth = HEADING.exec(block.tagName)?.[1]
    if (depth !== undefined) levels.set(paired.nodeId, Math.min(3, Number(depth)) as PaperAIOutlineEntry['level'])
  }
  return levels
}

/**
 * List the headings among the document's top-level blocks.
 * @param nodes - the document's node index in reading order.
 * @param previewHtml - the Host preview of the same document; its heading tags carry the document's Word styles.
 * @returns the headings, each with its level.
 */
export function outlineOf(nodes: readonly PaperAIDocumentNodeSummary[], previewHtml: string): PaperAIOutlineEntry[] {
  const levels = styledLevels(nodes, previewHtml)
  const entries: PaperAIOutlineEntry[] = []
  for (const node of nodes) {
    if (node.kind === 'table' || node.kind === 'table-cell' || node.depth > 0) continue
    const text = node.text.trim().replaceAll(/\s+/gu, ' ')
    if (text === '') continue
    // A document that states its headings is believed whole. The heuristics
    // cannot see a styled 研究方法 at all, and they read a generated table of
    // contents and numbered references as chapters, so a styled document
    // never runs them: every entry below is a style the writer applied.
    const level = levels.size > 0 ? (levels.get(node.nodeId) ?? null) : levelOf(text)
    if (level !== null) entries.push({ nodeId: node.nodeId, text, level })
  }
  return entries
}
