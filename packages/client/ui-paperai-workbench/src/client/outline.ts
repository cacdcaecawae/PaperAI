/** The document outline read off the node index: chapter, numbered and named headings with their levels. */

import type { PaperAIDocumentNodeSummary, PaperAIOutlineEntry } from './types.ts'

// ponytail: text heuristics stand in for Word heading styles, which the node
// index does not carry; move to a Host-emitted heading level when it does.
const CHAPTER = /^第\s*[一二三四五六七八九十百零\d]+\s*[章部篇]\s*\S/u
const NUMBERED = /^(\d{1,2}(?:\.\d{1,2})*)[．.]?\s+\S/u
// 一、 and （一） are the other numbering theses use; the parenthesised form sits one level down.
const CHINESE = /^[一二三四五六七八九十]+[、．.]\s*\S/u
const CHINESE_SUB = /^[（(][一二三四五六七八九十]+[）)]\s*\S/u
const NAMED = /^(?:摘\s*要|abstract|目\s*录|参\s*考\s*文\s*献|结\s*论|致\s*谢|绪\s*论|引\s*言|附\s*录\s*[A-Z\d]*)$/iu
const MAX_LENGTH = 60

function levelOf(node: PaperAIDocumentNodeSummary, text: string): PaperAIOutlineEntry['level'] | null {
  if (text === '' || text.length > MAX_LENGTH || /[。；;，,]$/u.test(text)) return null
  const numbered = NUMBERED.exec(text)
  if (numbered !== null) return Math.min(3, (numbered[1] ?? '').split('.').length) as PaperAIOutlineEntry['level']
  if (CHINESE_SUB.test(text)) return 2
  if (node.kind === 'heading' || CHAPTER.test(text) || CHINESE.test(text) || NAMED.test(text)) return 1
  return null
}

/**
 * List the headings among the document's top-level blocks.
 * @param nodes - the document's node index in reading order.
 * @returns the headings, each with its level.
 */
export function outlineOf(nodes: readonly PaperAIDocumentNodeSummary[]): PaperAIOutlineEntry[] {
  const entries: PaperAIOutlineEntry[] = []
  for (const node of nodes) {
    if (node.kind === 'table' || node.kind === 'table-cell' || node.depth > 0) continue
    const text = node.text.trim().replaceAll(/\s+/gu, ' ')
    const level = levelOf(node, text)
    if (level !== null) entries.push({ nodeId: node.nodeId, text, level })
  }
  return entries
}
