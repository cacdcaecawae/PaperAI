// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  applyRuns, fontOf, markDiffHtml, patchPreviewHtml, restateCleared, runsOf, sameRuns, textOf, wordDiff,
} from '../src/client/preview-html.ts'

const HTML = '<html><head></head><body>'
  + '<h1 data-path="/body/p[1]">Introduction</h1><p data-path="/body/p[2]">Research background</p>'
  + '<table><tr><td><p data-path="/body/tbl[1]/tr[1]/tc[1]/p[1]">Research background</p></td></tr></table>'
  + '<div class="doc-header"><p>Closing remarks</p></div><p data-path="/body/p[3]">Closing remarks</p>'
  + '<p data-path="/body/p[4]">Same</p><p data-path="/body/p[5]">Same</p>'
  + '</body></html>'

/** One rendered block with the given runs inside it, attached so its style resolves. */
function block(html: string, style = 'font-size: 12pt'): HTMLElement {
  const element = document.createElement('p')
  element.setAttribute('style', style)
  element.innerHTML = html
  document.body.replaceChildren(element)
  return element
}

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

describe('block runs', () => {
  it('keeps real soft breaks while omitting the browser caret placeholder', () => {
    const element = block('<span>first<br><br data-paperai-placeholder></span>')
    expect(textOf(element)).toBe('first\v')
    expect(runsOf(element)).toEqual([{ text: 'first\v' }])
  })

  it('reads a block as the runs Word stores, stating only what overrides the block', () => {
    expect(runsOf(block('<span>plain </span><span style="font-weight:bold">bold</span>'
      + '<span style="font-weight:bold">er</span><span style="font-size:16pt">big</span>'))).toEqual([
      { text: 'plain ' },
      { text: 'bolder', bold: true },
      { text: 'big', size: '16pt' },
    ])
  })

  it('reads italic, underline, and color, and states nothing for a run that reads as its block', () => {
    expect(runsOf(block('<span style="font-style:italic">sloped</span>'
      + '<span style="text-decoration:underline">lined</span>'
      + '<span style="color:rgb(255,0,0)">red</span><span style="font-size:12pt">same</span>'))).toEqual([
      { text: 'sloped', italic: true },
      { text: 'lined', underline: true },
      { text: 'red', color: '#FF0000' },
      { text: 'same' },
    ])
  })

  it('states a run that turns the block own formatting off', () => {
    expect(runsOf(block('<span style="font-weight:normal">quiet</span>', 'font-size: 12pt; font-weight: bold')))
      .toEqual([{ text: 'quiet', bold: false }])
  })

  it('keeps an underline stated by an ancestor of the run', () => {
    expect(runsOf(block('<span style="text-decoration:underline">under'
      + '<span style="font-weight:bold">bold</span></span>'))).toEqual([
      { text: 'under', underline: true },
      { text: 'bold', underline: true, bold: true },
    ])
  })

  it('states nothing for a run inside a block that is underlined itself', () => {
    expect(runsOf(block('<span style="font-weight:bold">bold</span>', 'font-size: 12pt; text-decoration: underline')))
      .toEqual([{ text: 'bold', bold: true }])
  })

  it('compares runs by text and formatting so an untouched block keeps no draft', () => {
    const runs = runsOf(block('<span style="font-weight:bold">bold</span>'))
    expect(sameRuns(runs, [{ text: 'bold', bold: true }])).toBe(true)
    expect(sameRuns(runs, [{ text: 'bold' }])).toBe(false)
    expect(sameRuns(runs, [{ text: 'bold', bold: true }, { text: '!' }])).toBe(false)
  })

  it('writes runs back as spans carrying their overrides', () => {
    const element = block('<span>before</span>')
    applyRuns(element, [{ text: 'plain' }, { text: 'loud', bold: true, size: '16pt', color: '#FF0000' }])
    expect(element.innerHTML)
      .toBe('<span>plain</span><span style="font-weight: bold; font-size: 16pt; color: rgb(255, 0, 0);">loud</span>')
    expect(runsOf(element)).toEqual([{ text: 'plain' }, { text: 'loud', bold: true, size: '16pt', color: '#FF0000' }])
  })

  it('paints a commit that carried formatting into the preview already on screen', () => {
    const patched = patchPreviewHtml(HTML, [{
      baseText: 'Introduction', nextText: 'Bold introduction', cell: false, ordinal: 0,
      runs: [{ text: 'Bold ' }, { text: 'introduction', bold: true }],
    }])
    expect(patched).toContain('<span style="font-weight: bold;">introduction</span>')
    expect(patched).not.toContain('>Introduction<')
  })
})

describe('clearing a run', () => {
  it('clears the DOCX font without storing the browser fallback family', () => {
    const element = block('plain', 'font-family:-apple-system, sans-serif')
    expect(fontOf(getComputedStyle(element))).toBe('')
    expect(restateCleared([{ text: 'plain' }], [{ text: 'plain', font: 'Arial' }], element))
      .toEqual([{ text: 'plain', font: '' }])
    element.style.fontFamily = 'Times New Roman'
    expect(restateCleared([{ text: 'plain' }], [{ text: 'plain', font: 'Arial' }], element))
      .toEqual([{ text: 'plain', font: 'Times New Roman' }])
  })
  it('states removed overrides as the block values', () => {
    const element = block('plain')
    expect(restateCleared([{ text: 'plain' }], [{ text: 'bold', bold: true, size: '16pt' }], element))
      .toEqual([{ text: 'plain', bold: false, size: '12pt' }])
  })

  it('keeps explicit overrides and clears omitted overrides after the first run', () => {
    const element = block('<span style="font-weight:bold">bold</span>plain')
    const runs = runsOf(element)
    expect(restateCleared(runs, [{ text: 'bold', bold: true }, { text: 'x', italic: true }], element)).toEqual([
      { text: 'bold', bold: true, italic: false }, { text: 'plain', bold: false, italic: false },
    ])
  })

  it('clears middle and trailing formatting after their text merges with a plain lead', () => {
    const element = block('lead<span style="font-weight:bold;font-style:italic;text-decoration:underline">middle</span>'
      + '<span style="font-family:Arial;font-size:16pt;color:#FF0000">tail</span>',
    'font-family:Calibri;font-size:12pt;color:#112233')
    const previous = runsOf(element)
    element.textContent = 'leadmiddletail'
    expect(restateCleared(runsOf(element), previous, element)).toEqual([{
      text: 'leadmiddletail', bold: false, italic: false, underline: false,
      font: 'Calibri', size: '12pt', color: '#112233',
    }])
  })

  it('retains explicit mixed fonts while clearing another run to the paragraph font', () => {
    const element = block('<span style="font-family:Arial">Latin</span>正文'
      + '<span style="font-family:SimSun">中文</span>', 'font-family:Calibri;font-size:12pt')
    const previous = [{ text: 'Latin', font: 'Arial' }, { text: '正文', font: 'SimHei' }, { text: '中文', font: 'SimSun' }]
    expect(restateCleared(runsOf(element), previous, element)).toEqual([
      { text: 'Latin', font: 'Arial' }, { text: '正文', font: 'Calibri' }, { text: '中文', font: 'SimSun' },
    ])
  })

  it('does not add font or size declarations for an emphasis-only edit with a soft break', () => {
    const element = block('first<br><span style="font-style:italic">last</span>', 'font-family:Calibri;font-size:12pt')
    expect(restateCleared(runsOf(element), [{ text: 'first\v' }, { text: 'last', bold: true }], element)).toEqual([
      { text: 'first\v', bold: false }, { text: 'last', italic: true, bold: false },
    ])
    expect(restateCleared([], [{ text: 'last', bold: true }], element)).toEqual([])
    expect(restateCleared([{ text: 'new' }], [], element)).toEqual([{ text: 'new' }])
  })
})
