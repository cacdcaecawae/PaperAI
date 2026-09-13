/** Character-format changes relative to the rendered baseline; full drafts remain available for repainting. */
import { diffArrays } from 'diff'
import type { PaperAIBlockEdit, PaperAIDocumentTextRun, PaperAIFormatComparison } from './types.ts'

const KEYS = ['bold', 'italic', 'underline', 'size', 'color', 'font'] as const
type Run = PaperAIDocumentTextRun

function append(runs: Run[], run: Run): void {
  const previous = runs.at(-1)
  if (previous !== undefined && previous.text !== '' && run.text !== '' && KEYS.every(key => previous[key] === run[key])) {
    runs[runs.length - 1] = { ...previous, text: previous.text + run.text }
  } else runs.push(run)
}

function overrides(before: Run | undefined, after: Run): Omit<Run, 'text'> {
  return Object.fromEntries(KEYS.filter(key => after[key] !== before?.[key]
    && after[key] !== undefined && !((key === 'size' || key === 'color') && after[key] === ''))
    .map(key => [key, after[key]]))
}

function changedRuns({ before, after }: PaperAIFormatComparison): Run[] {
  const original = before.flatMap(run => Array.from(run.text, text => ({ text, run })))
  const sources: Array<Run | undefined> = []
  let offset = 0
  let removedAt: number | undefined
  for (const edit of diffArrays(original.map(item => item.text), Array.from(after.map(run => run.text).join('')))) {
    if (edit.removed) {
      removedAt = offset
      offset += edit.value.length
    } else if (edit.added) {
      const source = original[removedAt ?? Math.max(0, offset - 1)]?.run ?? before.at(-1)
      sources.push(...edit.value.map(() => source))
      removedAt = undefined
    } else {
      removedAt = undefined
      for (const _text of edit.value) sources.push(original[offset++]?.run)
    }
  }
  const runs: Run[] = []
  let position = 0
  for (const run of after) {
    if (run.text === '') append(runs, { text: '', ...overrides(sources[position - 1] ?? sources[position] ?? before.at(-1), run) })
    for (const text of Array.from(run.text)) append(runs, { text, ...overrides(sources[position++], run) })
  }
  return runs
}

function splitRuns(runs: readonly Run[]): Run[][] {
  const paragraphs: Run[][] = [[]]
  for (const run of runs) {
    for (const [index, text] of run.text.split('\n').entries()) {
      if (index > 0) paragraphs.push([])
      if (text !== '' || run.text === '') append(paragraphs.at(-1) as Run[], { ...run, text })
    }
  }
  return paragraphs
}

const formatted = (runs: readonly Run[]): boolean => runs.some(run => KEYS.some(key => run[key] !== undefined))

/**
 * Serialize only changed character properties while keeping explicit paragraph settings and text splits.
 * @param edit - full render draft and its original/current effective readings, when supplied by the preview.
 * @returns run or paragraph overrides for the Word commit; no browser comparison data crosses the RPC.
 */
export function commitFormatting(edit: PaperAIBlockEdit): Pick<PaperAIBlockEdit, 'runs' | 'paragraphs'> {
  if (edit.formatting === undefined) return {
    ...(edit.runs === undefined ? {} : { runs: edit.runs }),
    ...(edit.paragraphs === undefined ? {} : { paragraphs: edit.paragraphs }),
  }
  const runs = changedRuns(edit.formatting)
  if (edit.paragraphs === undefined) return formatted(runs) ? { runs } : {}
  const paragraphs = splitRuns(runs)
  return { paragraphs: edit.paragraphs.map(({ runs: _renderRuns, ...paragraph }, index) => {
    const changes = paragraphs[index] as Run[]
    return { ...paragraph, ...(formatted(changes) ? { runs: changes } : {}) }
  }) }
}
