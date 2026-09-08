import { describe, expect, it } from 'vitest'
import { diffParagraphs } from '../src/diff.ts'

describe('document version paragraph changes', () => {
  it('preserves insertions ahead of repeated paragraphs and pairs rewritten hunks', () => {
    expect(diffParagraphs(['a', 'b', 'a'], ['inserted', 'a', 'b', 'a'])).toEqual({
      changes: [{ kind: 'added', after: 'inserted' }], unchangedCount: 3,
    })
    expect(diffParagraphs(['old', 'removed', 'tail'], ['new', 'tail'])).toEqual({
      changes: [{ kind: 'changed', before: 'old', after: 'new' }, { kind: 'removed', before: 'removed' }], unchangedCount: 1,
    })
    expect(diffParagraphs([], ['first'])).toEqual({ changes: [{ kind: 'added', after: 'first' }], unchangedCount: 0 })
    expect(diffParagraphs(['last'], [])).toEqual({ changes: [{ kind: 'removed', before: 'last' }], unchangedCount: 0 })
  })

  it('bounds comparisons for long documents while retaining replacements and unmatched trailing paragraphs', () => {
    const before = Array.from({ length: 2001 }, (_, index) => `paragraph ${index}`)
    const after = [...before]
    after[1000] = 'revised paragraph'
    after.push('appendix')
    const result = diffParagraphs(before, after)
    expect(result).toEqual({ unchangedCount: 2000, changes: [
      { kind: 'changed', before: 'paragraph 1000', after: 'revised paragraph' },
      { kind: 'added', after: 'appendix' },
    ] })
    expect(diffParagraphs(after, before).changes).toEqual([
      { kind: 'changed', before: 'revised paragraph', after: 'paragraph 1000' },
      { kind: 'removed', before: 'appendix' },
    ])
  })
})
