/** Paragraph-level diff between two text sequences for the version timeline. */

import { diffArrays } from 'diff'
import type { PaperAIVersionChange } from './types.ts'

/** Above this many paragraph pairs the diff falls back to position alignment. */
const MAX_PARAGRAPH_PAIRS = 4_000_000

/** Result of diffing two paragraph sequences. */
export interface ParagraphDiff {
  readonly changes: readonly PaperAIVersionChange[]
  readonly unchangedCount: number
}

/**
 * Diff two paragraph sequences. Adjacent removals and additions pair up as
 * `changed` entries so a rewritten paragraph reads as one change rather than
 * a delete plus an insert; leftover removals and additions stay separate.
 * @param before - paragraphs of the parent version in document order.
 * @param after - paragraphs of the version in document order.
 * @returns the changes in document order plus the count of untouched paragraphs.
 */
export function diffParagraphs(before: readonly string[], after: readonly string[]): ParagraphDiff {
  const script = before.length * after.length > MAX_PARAGRAPH_PAIRS
    ? alignByPosition(before, after)
    : alignByDiff(before, after)
  const changes: PaperAIVersionChange[] = []
  let unchangedCount = 0
  let removed: string[] = []
  let added: string[] = []
  const flush = (): void => {
    const paired = Math.min(removed.length, added.length)
    for (let pair = 0; pair < paired; pair++) {
      changes.push({ kind: 'changed', before: removed[pair] ?? '', after: added[pair] ?? '' })
    }
    for (const text of removed.slice(paired)) changes.push({ kind: 'removed', before: text })
    for (const text of added.slice(paired)) changes.push({ kind: 'added', after: text })
    removed = []
    added = []
  }
  // One hunk is a run of removals and additions between two equal paragraphs.
  for (const step of script) {
    if (step.kind === 'equal') {
      flush()
      unchangedCount++
    } else if (step.kind === 'removed') {
      removed.push(step.text)
    } else {
      added.push(step.text)
    }
  }
  flush()
  return { changes, unchangedCount }
}

type EditStep =
  | { readonly kind: 'equal'; readonly text: string }
  | { readonly kind: 'removed'; readonly text: string }
  | { readonly kind: 'added'; readonly text: string }

function alignByDiff(before: readonly string[], after: readonly string[]): EditStep[] {
  return diffArrays([...before], [...after]).flatMap(part => part.value.map(text => ({
    kind: part.added ? 'added' : part.removed ? 'removed' : 'equal', text,
  })))
}

function alignByPosition(before: readonly string[], after: readonly string[]): EditStep[] {
  const script: EditStep[] = []
  const shared = Math.min(before.length, after.length)
  for (let index = 0; index < shared; index++) {
    const left = before[index] ?? ''
    const right = after[index] ?? ''
    if (left === right) {
      script.push({ kind: 'equal', text: left })
    } else {
      script.push({ kind: 'removed', text: left }, { kind: 'added', text: right })
    }
  }
  for (const text of before.slice(shared)) script.push({ kind: 'removed', text })
  for (const text of after.slice(shared)) script.push({ kind: 'added', text })
  return script
}
