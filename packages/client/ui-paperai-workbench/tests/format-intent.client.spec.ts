import { describe, expect, it } from 'vitest'
import { commitFormatting } from '../src/client/format-intent.ts'
import type { PaperAIBlockEdit, PaperAIDocumentTextRun } from '../src/client/types.ts'
import { NODE_PARAGRAPH } from './fixtures.client.ts'

const base = { bold: false, italic: false, underline: false, font: 'Times New Roman', size: '12pt', color: '#000000' }
const run = (text: string, format: Partial<PaperAIDocumentTextRun> = {}): PaperAIDocumentTextRun => ({ ...base, text, ...format })
function edit(before: PaperAIDocumentTextRun[], after: PaperAIDocumentTextRun[], paragraphs?: PaperAIBlockEdit['paragraphs']): PaperAIBlockEdit {
  return { nodeId: NODE_PARAGRAPH, baseText: before.map(run => run.text).join(''), draft: after.map(run => run.text).join(''),
    runs: after, ...(paragraphs === undefined ? {} : { paragraphs }), formatting: { before, after } }
}

describe('Word formatting intent', () => {
  it('omits displayed font and size when typing only changes text', () => {
    const draft = edit([run('层次'), run('代号'), run('及说明')], [run('层次代号及说明（验收）')])
    expect(commitFormatting(draft)).toEqual({})
    expect(draft.runs?.[0]?.font).toBe('Times New Roman')
    expect(draft.formatting?.before).toHaveLength(3)
  })

  it('sends only changed bold values and retains both sides of a mixed-font selection', () => {
    const before = [run('ABC', { font: 'Arial', bold: true }), run('中文', { font: '宋体' }), run('tail', { font: 'Calibri' })]
    expect(commitFormatting(edit(before, [run('A', { font: 'Arial', bold: true }), run('BC', { font: 'Arial' }),
      run('中文', { font: '宋体', bold: true }), run('tail', { font: 'Calibri' })])))
      .toEqual({ runs: [{ text: 'A' }, { text: 'BC', bold: false }, { text: '中文', bold: true }, { text: 'tail' }] })
  })

  it('keeps unmodified mixed formatting through several independent replacements and insertions', () => {
    const before = [run('cat ', { font: 'Arial', bold: true }), run('walks ', { font: '宋体' }), run('home.', { font: 'Calibri' })]
    const after = [run('dog ', { font: 'Arial', bold: true }), run('walks ', { font: '宋体' }), run('home!', { font: 'Calibri' })]
    expect(commitFormatting(edit(before, after))).toEqual({})
  })

  it.each(['start', 'middle', 'end'] as const)('inherits inserted text from the original adjacent run at the %s', (position) => {
    const before = [run('AB', { font: 'Arial' }), run('中文', { font: '宋体' })]
    const after = position === 'start' ? [run('newAB', { font: 'Arial' }), run('中文', { font: '宋体' })]
      : position === 'middle' ? [run('ABnew', { font: 'Arial' }), run('中文', { font: '宋体' })]
        : [run('AB', { font: 'Arial' }), run('中文new', { font: '宋体' })]
    expect(commitFormatting(edit(before, after))).toEqual({})
  })

  it('commits explicit format removal while omitting unchanged font and size', () => {
    expect(commitFormatting(edit([run('text', { bold: true, italic: true, underline: true })], [run('text')]))).toEqual({
      runs: [{ text: 'text', bold: false, italic: false, underline: false }],
    })
    expect(commitFormatting(edit([run('text')], [run('text', { font: '' })]))).toEqual({ runs: [{ text: 'text', font: '' }] })
  })

  it('commits changed font, size and color only for the selected text', () => {
    expect(commitFormatting(edit([run('abc')], [run('a'), run('b', { font: 'Arial', size: '18pt', color: '#FF0000' }), run('c')]))).toEqual({
      runs: [{ text: 'a' }, { text: 'b', font: 'Arial', size: '18pt', color: '#FF0000' }, { text: 'c' }],
    })
  })

  it('does not treat reselecting the same effective formatting as a Word override', () => {
    expect(commitFormatting(edit([run('text')], [run('text')]))).toEqual({})
  })

  it('uses the empty paragraph reading when typing into an initially empty formatted paragraph', () => {
    expect(commitFormatting(edit([run('', { font: '宋体', bold: true })], [run('新增', { font: '宋体', bold: true })]))).toEqual({})
  })

  it('changes an initially empty paragraph layout without restating its character seed', () => {
    const seed = [run('', { font: '宋体', bold: true })]
    const paragraphs = [{ text: '', format: { align: 'center' as const } }]
    expect(commitFormatting(edit(seed, seed, paragraphs))).toEqual({ paragraphs })
  })

  it('keeps structural splits and layout while omitting unchanged character formatting', () => {
    const before = [run('AB尾段', { bold: true })]
    const after = [run('AB\n新增\vsoft\n尾段', { bold: true })]
    const paragraphs = [{ text: 'AB', format: { align: 'center' as const }, runs: [run('AB', { bold: true })] },
      { text: '新增\vsoft', runs: [run('新增\vsoft', { bold: true })] }, { text: '尾段', runs: [run('尾段', { bold: true })] }]
    expect(commitFormatting(edit(before, after, paragraphs))).toEqual({ paragraphs: [
      { text: 'AB', format: { align: 'center' } }, { text: '新增\vsoft' }, { text: '尾段' },
    ] })
  })

  it('preserves an empty split paragraph character change instead of putting it on the newline', () => {
    const before = [run('A')]
    const after = [run('A'), run('\n', { bold: true }), run('', { bold: true })]
    expect(commitFormatting(edit(before, after, [{ text: 'A' }, { text: '' }]))).toEqual({ paragraphs: [
      { text: 'A' }, { text: '', runs: [{ text: '', bold: true }] },
    ] })
  })

  it('preserves the first run insertion style when Enter leaves a leading empty paragraph', () => {
    const before = [run('A', { font: 'Arial', bold: true }), run('B', { font: '宋体' })]
    const after = [run('', { font: 'Arial', bold: true }), run('\nA', { font: 'Arial', bold: true }), run('B', { font: '宋体' })]
    expect(commitFormatting(edit(before, after, [{ text: '' }, { text: 'AB' }]))).toEqual({ paragraphs: [
      { text: '' }, { text: 'AB' },
    ] })
  })

  it('aligns supplementary characters and retains actual soft-break text', () => {
    expect(commitFormatting(edit([run('A😀\vB')], [run('A😀'), run('\vB', { italic: true })]))).toEqual({
      runs: [{ text: 'A😀' }, { text: '\vB', italic: true }],
    })
  })

  it('omits unavailable color and size readings without suppressing a valid change', () => {
    expect(commitFormatting(edit([run('text')], [run('text', { size: '', color: '', bold: true })]))).toEqual({
      runs: [{ text: 'text', bold: true }],
    })
  })

  it('keeps explicit programmatic drafts that have no browser comparison', () => {
    expect(commitFormatting({ nodeId: NODE_PARAGRAPH, baseText: 'old', draft: 'new' })).toEqual({})
    expect(commitFormatting({ nodeId: NODE_PARAGRAPH, baseText: 'old', draft: 'new', runs: [{ text: 'new', bold: true }] }))
      .toEqual({ runs: [{ text: 'new', bold: true }] })
    expect(commitFormatting({ nodeId: NODE_PARAGRAPH, baseText: 'old', draft: 'new', paragraphs: [{ text: 'new' }] }))
      .toEqual({ paragraphs: [{ text: 'new' }] })
  })
})
