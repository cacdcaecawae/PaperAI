// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { markDiffHtml, patchPreviewHtml, wordDiff } from '../src/client/preview-html.ts'

const HTML = '<html><head></head><body>'
  + '<h1 data-path="/body/p[1]">Introduction</h1><p data-path="/body/p[2]">Research background</p>'
  + '<table><tr><td><p data-path="/body/tbl[1]/tr[1]/tc[1]/p[1]">Research background</p></td></tr></table>'
  + '<div class="doc-header"><p>Closing remarks</p></div><p data-path="/body/p[3]">Closing remarks</p>'
  + '<p data-path="/body/p[4]">Same</p><p data-path="/body/p[5]">Same</p>'
  + '</body></html>'

describe('wordDiff', () => {
  it('keeps common words and marks the rest, deletions first, one CJK character at a time', () => {
    expect(wordDiff('Old introduction', 'Introduction')).toEqual([['del', 'Old introduction'], ['ins', 'Introduction']])
    expect(wordDiff('the old text here', 'the new text')).toEqual([
      ['same', 'the '], ['del', 'old'], ['ins', 'new'], ['same', ' text'], ['del', ' here'],
    ])
    expect(wordDiff('本课题旨在构建系统', '本课题旨在构建工作台')).toEqual([
      ['same', '本课题旨在构建'], ['del', '系统'], ['ins', '工作台'],
    ])
    expect(wordDiff('', 'new')).toEqual([['ins', 'new']])
    expect(wordDiff('gone', '')).toEqual([['del', 'gone']])
  })
})

describe('markDiffHtml', () => {
  it('marks a change only where exactly one addressed body block carries its text, and lists the rest', () => {
    const result = markDiffHtml(HTML, [
      { kind: 'removed', before: 'A dropped paragraph' },
      { kind: 'changed', before: 'Old introduction', after: 'Introduction' },
      { kind: 'added', after: 'Closing remarks' },
      { kind: 'changed', before: 'Different', after: 'Same' },
      { kind: 'changed', before: 'Once here', after: 'Overwritten later' },
    ])
    expect(result.unplaced).toEqual([
      { kind: 'removed', before: 'A dropped paragraph' },
      { kind: 'changed', before: 'Different', after: 'Same' },
      { kind: 'changed', before: 'Once here', after: 'Overwritten later' },
    ])
    const marked = new DOMParser().parseFromString(result.html, 'text/html')
    const changes = [...marked.querySelectorAll('[data-paperai-change]')]
    expect(changes.map(block => block.getAttribute('data-path'))).toEqual(['/body/p[1]', '/body/p[3]'])
    expect(changes[0]?.innerHTML).toBe('<del>Old introduction</del><ins>Introduction</ins>')
    expect(changes[1]?.innerHTML).toBe('<ins>Closing remarks</ins>')
    // The header with the same text is not a body block and stays as it was.
    expect(marked.querySelector('.doc-header p')?.innerHTML).toBe('Closing remarks')
  })
})

describe('patchPreviewHtml', () => {
  it('retypes the block the editor mapping names: same kind, same text, same ordinal', () => {
    const patched = new DOMParser().parseFromString(patchPreviewHtml(HTML, [
      { baseText: 'Research background', nextText: 'Research context', cell: false, ordinal: 0 },
      { baseText: 'Closing remarks', nextText: 'Closing words', cell: false, ordinal: 0 },
      { baseText: 'Same', nextText: 'Second same', cell: false, ordinal: 1 },
      { baseText: 'Same', nextText: 'Nowhere', cell: false, ordinal: 5 },
    ]), 'text/html')
    expect(patched.querySelector('[data-path="/body/p[2]"]')?.textContent).toBe('Research context')
    expect(patched.querySelector('td')?.textContent).toBe('Research background')
    expect(patched.querySelector('.doc-header')?.textContent).toBe('Closing remarks')
    expect(patched.querySelector('[data-path="/body/p[3]"]')?.textContent).toBe('Closing words')
    expect(patched.querySelector('[data-path="/body/p[4]"]')?.textContent).toBe('Same')
    expect(patched.querySelector('[data-path="/body/p[5]"]')?.textContent).toBe('Second same')
    const cellPatched = new DOMParser().parseFromString(patchPreviewHtml(HTML, [
      { baseText: 'Research background', nextText: 'Cell context', cell: true, ordinal: 0 },
    ]), 'text/html')
    expect(cellPatched.querySelector('td')?.textContent).toBe('Cell context')
    expect(cellPatched.querySelector('[data-path="/body/p[2]"]')?.textContent).toBe('Research background')
  })
})
