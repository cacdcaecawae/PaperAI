/** Paragraph-level diff between two text sequences for the version timeline. */

import type { PaperAIVersionChange } from './types.ts'

/** Above this many cell comparisons the diff falls back to position alignment. */
const MAX_LCS_CELLS = 4_000_000

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
  const script = before.length * after.length > MAX_LCS_CELLS
    ? alignByPosition(before, after)
    : alignByLcs(before, after)
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

function alignByLcs(before: readonly string[], after: readonly string[]): EditStep[] {
  const columns = after.length + 1
  // lengths[i * columns + j] = LCS length of before[i..] and after[j..]; the
  // typed array reads 0 past either end, which is the empty-suffix base case.
  const lengths = new Uint32Array((before.length + 1) * columns)
  const at = (i: number, j: number): number => lengths[i * columns + j] ?? 0
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i * columns + j] = before[i] === after[j]
        ? at(i + 1, j + 1) + 1
        : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const script: EditStep[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    const left = before[i] ?? ''
    const right = after[j] ?? ''
    if (left === right) {
      script.push({ kind: 'equal', text: left })
      i++
      j++
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      script.push({ kind: 'removed', text: left })
      i++
    } else {
      script.push({ kind: 'added', text: right })
      j++
    }
  }
  for (const text of before.slice(i)) script.push({ kind: 'removed', text })
  for (const text of after.slice(j)) script.push({ kind: 'added', text })
  return script
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
