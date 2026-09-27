// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentPreview, type DocumentPreviewProps } from '../src/client/DocumentPreview.tsx'
import { zh } from '../src/client/locales.ts'
import { NODE_HEADING, NODE_PARAGRAPH, REVISION_2 } from './fixtures.client.ts'
import {
  applyRuns, blocksOf, conflictBand, effectiveRunsOf, fontOf, markDiffHtml, patchPreviewHtml, restateCleared, runsOf, sameRuns,
  textOf, wordDiff, type ConflictBandSide,
} from '../src/client/preview-html.ts'

afterEach(cleanup)

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

  it('marks one character changed in a long paragraph, however long, because the shared ends need no table', () => {
    // 501 Han characters a side, because TOKEN counts each one: 251_001 cells for the whole pair, past the default.
    expect(wordDiff(`${'本'.repeat(500)}甲`, `${'本'.repeat(500)}乙`)).toEqual([['same', '本'.repeat(500)], ['del', '甲'], ['ins', '乙']])
    expect(wordDiff(`甲${'本'.repeat(1000)}`, `乙${'本'.repeat(1000)}`)).toEqual([['del', '甲'], ['ins', '乙'], ['same', '本'.repeat(1000)]])
  })

  it('gives up on a middle past the default cap and marks the same pair once a caller raises it', () => {
    // Different at both ends, so the whole 501×501 middle needs the table.
    const before = `甲${'本'.repeat(500)}`
    const after = `乙${'本'.repeat(499)}丙`
    expect(wordDiff(before, after)).toEqual([['del', before], ['ins', after]])
    expect(wordDiff(before, after, 1_000_000).find(([kind]) => kind === 'same')?.[1]).toBe('本'.repeat(499))
  })
})

describe('markDiffHtml', () => {
  it('walks the alignment along the page in order, marks changes in place, and draws removed paragraphs where they stood', () => {
    const result = markDiffHtml(HTML, [
      { kind: 'changed', before: 'Old introduction', after: 'Introduction' },
      { kind: 'equal', before: 'Research background', after: 'Research background' },
      { kind: 'equal', before: 'Research background', after: 'Research background' },
      { kind: 'removed', before: 'A dropped paragraph' },
      { kind: 'added', after: 'Closing remarks' },
      { kind: 'changed', before: 'Different', after: 'Same' },
      { kind: 'equal', before: 'Same', after: 'Same' },
    ])
    expect(result.count).toBe(4)
    const marked = new DOMParser().parseFromString(result.html, 'text/html')
    const changes = [...marked.querySelectorAll('[data-paperai-change]')]
    expect(changes.map(block => block.getAttribute('data-path'))).toEqual(['/body/p[1]', null, '/body/p[3]', '/body/p[4]'])
    expect(changes[0]?.innerHTML).toBe('<del>Old introduction</del><ins>Introduction</ins>')
    // The dropped paragraph stands where it was: before the paragraph that followed it.
    expect(changes[1]?.innerHTML).toBe('<del>A dropped paragraph</del>')
    expect(changes[1]?.hasAttribute('data-paperai-removed')).toBe(true)
    expect(changes[1]?.nextElementSibling).toBe(changes[2])
    expect(changes[2]?.innerHTML).toBe('<ins>Closing remarks</ins>')
    // Repeated text is settled by order: the first "Same" is the changed one, the second stays.
    expect(changes[3]?.innerHTML).toBe('<del>Different</del><ins>Same</ins>')
    expect(marked.querySelector('[data-path="/body/p[5]"]')?.innerHTML).toBe('Same')
    // The header with the same text is not a body block and stays as it was.
    expect(marked.querySelector('.doc-header p')?.innerHTML).toBe('Closing remarks')
  })

  it('leaves a step whose paragraph is out of reach unmarked and keeps walking', () => {
    const result = markDiffHtml(HTML, [
      { kind: 'changed', before: 'Nowhere', after: 'Not on this page' },
      { kind: 'changed', before: 'Old introduction', after: 'Introduction' },
    ])
    expect(result.count).toBe(1)
    const marked = new DOMParser().parseFromString(result.html, 'text/html')
    expect(marked.querySelector('[data-paperai-change]')?.getAttribute('data-path')).toBe('/body/p[1]')
  })

  it('keeps removed paragraphs past the last block in their own order', () => {
    const result = markDiffHtml(HTML, [
      { kind: 'equal', before: 'Introduction', after: 'Introduction' },
      { kind: 'equal', before: 'Research background', after: 'Research background' },
      { kind: 'equal', before: 'Research background', after: 'Research background' },
      { kind: 'equal', before: 'Closing remarks', after: 'Closing remarks' },
      { kind: 'equal', before: 'Same', after: 'Same' },
      { kind: 'equal', before: 'Same', after: 'Same' },
      { kind: 'removed', before: 'Gone first' },
      { kind: 'removed', before: 'Gone second' },
    ])
    expect(result.count).toBe(2)
    const marked = new DOMParser().parseFromString(result.html, 'text/html')
    const last = marked.querySelector('[data-path="/body/p[5]"]')
    expect(last?.nextElementSibling?.innerHTML).toBe('<del>Gone first</del>')
    expect(last?.nextElementSibling?.nextElementSibling?.innerHTML).toBe('<del>Gone second</del>')
  })
})

describe('patchPreviewHtml', () => {
  it('keeps a formatted paragraph addressable after the committed HTML is parsed again', () => {
    const patched = patchPreviewHtml(HTML, [{
      baseText: 'Research background', nextText: 'Research background', cell: false, ordinal: 0,
      paragraphs: [{ text: 'Research background', format: { align: 'center', indent: '12pt', lineSpacing: '1.5x' } }],
    }])
    const parsed = new DOMParser().parseFromString(patched, 'text/html')
    const paragraph = blocksOf(parsed.body).find(element => element.dataset.path === '/body/p[2]')!
    expect(textOf(paragraph)).toBe('Research background')
    expect(paragraph.style.textAlign).toBe('center')
    expect(paragraph.style.marginLeft).toBe('12pt')
    expect(paragraph.style.lineHeight).toBe('1.5')
    expect(parsed.querySelector('td')?.textContent).toBe('Research background')
  })

  it.each(['p', 'h2'])('keeps each committed split of a %s available to the refreshed node mapping', (tag) => {
    const source = `<${tag} data-path="/body/p[1]" style="font-family:Arial;font-size:12pt">Research background</${tag}>`
      + '<p data-path="/body/p[2]">Closing remarks</p>'
    const patched = patchPreviewHtml(source, [{
      baseText: 'Research background', nextText: 'Research\nbackground', cell: false, ordinal: 0,
      paragraphs: [
        { text: 'Research', runs: [{ text: 'Research', bold: true }], format: { align: 'center' } },
        { text: 'background', format: { align: 'right' } },
      ],
    }])
    const parsed = new DOMParser().parseFromString(patched, 'text/html')
    const addressed = blocksOf(parsed.body).filter(element => element.dataset.path !== undefined)
    expect(addressed.map(textOf)).toEqual(['Research', 'background', 'Closing remarks'])
    expect(addressed.slice(0, 2).map(element => element.style.textAlign)).toEqual(['center', 'right'])
    expect(addressed[0]?.querySelector('span')?.style.fontWeight).toBe('bold')
    expect(addressed[2]?.dataset.path).toBe('/body/p[2]')
  })

  it('keeps original duplicate-text targets and gives each split its own paragraph format', () => {
    const source = '<p id="first" data-path="/body/p[1]" style="text-align:left;font-size:12pt">Same</p>'
      + '<p id="second" data-path="/body/p[2]">Same</p>'
    const patched = patchPreviewHtml(source, [
      { baseText: 'Same', nextText: 'Same\nSame', cell: false, ordinal: 0,
        paragraphs: [{ text: 'Same', format: { align: 'center' } }, { text: 'Same' }] },
      { baseText: 'Same', nextText: 'Second same', cell: false, ordinal: 1,
        paragraphs: [{ text: 'Second same', format: { align: 'right' } }] },
    ])
    const parsed = new DOMParser().parseFromString(patched, 'text/html')
    const blocks = blocksOf(parsed.body)
    expect(blocks.map(textOf)).toEqual(['Same', 'Same', 'Second same'])
    expect(blocks.map(element => element.style.textAlign)).toEqual(['center', 'left', 'right'])
    expect(blocks.slice(0, 2).map(element => element.style.fontSize)).toEqual(['12pt', '12pt'])
    expect(parsed.querySelectorAll('#first')).toHaveLength(1)
    expect(parsed.querySelector('#second')?.textContent).toBe('Second same')
  })

  it.each(['p', 'td', 'th'])('keeps a single formatted table %s inside its existing cell structure', (tag) => {
    const content = `<${tag} data-path="/body/tbl[1]/tr[1]/tc[1]/p[1]">Cell</${tag}>`
    const source = `<table><tr>${tag === 'p' ? `<td>${content}</td>` : content}</tr></table>`
    const patched = patchPreviewHtml(source, [{ baseText: 'Cell', nextText: 'Cell', cell: true, ordinal: 0,
      paragraphs: [{ text: 'Cell', format: { align: 'center' } }] }])
    const parsed = new DOMParser().parseFromString(patched, 'text/html')
    const blocks = blocksOf(parsed.body)
    expect(blocks.map(textOf)).toEqual(['Cell'])
    expect(blocks[0]?.tagName).toBe(tag.toUpperCase())
    expect(blocks[0]?.closest('td, th')).not.toBeNull()
    expect(blocks[0]?.style.textAlign).toBe('center')
    expect(parsed.querySelectorAll('tr')).toHaveLength(1)
    expect(parsed.querySelectorAll('td, th')).toHaveLength(1)
  })

  it.each(['paragraphs', 'runs', 'plain'])('keeps committed empty %s empty through the actual preview sanitizer and node mapping', (mode) => {
    const texts = mode === 'paragraphs' ? ['Research\vmore', ''] : ['']
    const html = patchPreviewHtml('<p data-path="/body/p[1]">Research</p>', [{
      baseText: 'Research', nextText: texts.join('\n'), cell: false, ordinal: 0,
      ...(mode === 'paragraphs' ? {
        paragraphs: [{ text: texts[0]! }, { text: '', runs: [{ text: '', font: 'Arial', bold: true }] }],
      } : mode === 'runs' ? { runs: [{ text: '', font: 'Arial', bold: true }] } : {}),
    }])
    const t = ((key: keyof typeof zh) => zh[key]) as DocumentPreviewProps['t']
    const view = render(createElement(DocumentPreview, {
      html, revision: REVISION_2, title: 'Document', paragraphStyles: [], edits: [], saving: false,
      onDraft: vi.fn(), onSave: vi.fn(), onCancel: vi.fn(), t,
      nodes: texts.map((text, index) => ({ nodeId: index === 0 ? NODE_HEADING : NODE_PARAGRAPH,
        text, label: text || 'Empty paragraph', kind: 'paragraph' as const, depth: 0, editable: true })),
    }))
    const shadow = view.container.querySelector('[role="document"]')!.shadowRoot!
    const blocks = [...shadow.querySelectorAll<HTMLElement>('[data-paperai-block]')]
    expect(blocks.map(element => element.getAttribute('contenteditable'))).toEqual(texts.map(() => 'true'))
    expect(blocks.map(textOf)).toEqual(texts)
    if (mode !== 'plain') expect(effectiveRunsOf(blocks.at(-1)!)).toEqual([expect.objectContaining({ text: '', font: 'Arial', bold: true })])
  })

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
  it('reads empty insertion formatting from its placeholder span and preserves it through repaint', () => {
    const element = block('<span style="font-weight:normal"></span>'
      + '<span style="font-family:Arial;font-size:18pt;font-weight:bold"><br data-paperai-placeholder></span>'
      + '<span style="font-weight:normal"></span>')
    const reading = effectiveRunsOf(element)
    expect(reading).toEqual([expect.objectContaining({ text: '', bold: true, font: 'Arial', size: '18pt' })])
    applyRuns(element, reading)
    expect(element.querySelectorAll('br[data-paperai-placeholder]')).toHaveLength(1)
    expect(element.querySelector('br')?.parentElement?.style.fontWeight).toBe('bold')
    expect(textOf(element)).toBe('')
    expect(runsOf(element)).toEqual([])
    expect(effectiveRunsOf(element)).toEqual(reading)
  })

  it('uses a native empty formatted span as a baseline before the editor has a placeholder', () => {
    const element = block('<span style="font-family:宋体;font-weight:bold"></span>')
    expect(effectiveRunsOf(element)).toEqual([expect.objectContaining({ text: '', font: '宋体', bold: true })])
  })
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

/** One band's input. The copy is marker text, so an assertion names the string the band picked rather than matching prose. */
function side(form: ConflictBandSide['form'], mine: string, theirs: string, base = mine): ConflictBandSide {
  return {
    nodeId: NODE_PARAGRAPH,
    form,
    theirs,
    mine,
    base,
    copy: {
      label: 'label', who: 'who', legend: 'legend', rewritten: 'rewritten', empty: 'empty',
      actions: form === 'draft'
        ? [{ resolve: 'copy', label: 'copy' }, { resolve: 'drop', label: 'drop' }]
        : [{ resolve: 'mine', label: 'mine' }, { resolve: 'theirs', label: 'theirs' }],
    },
  }
}

describe('conflictBand', () => {
  it('quotes the document marked against the draft, and carries nothing that would let the band reach the thesis', () => {
    const band = conflictBand(document, side('document',
      '本课题旨在构建一个面向中文学位论文的写作工作台。', '本课题旨在构建一个面向中文学位论文的批改工作台。'))
    expect(band.dataset.paperaiConflict).toBe(NODE_PARAGRAPH)
    expect(band.dataset.paperaiConflictForm).toBe('document')
    expect(band.getAttribute('contenteditable')).toBe('false')
    // The three absences are the band's whole claim to being inert: no data-path, so the node mapping
    // and the report never see it; no data-paperai-change, so the change navigator never steps onto it.
    expect(band.hasAttribute('data-path')).toBe(false)
    expect(band.hasAttribute('data-paperai-change')).toBe(false)
    expect(band.querySelectorAll('[data-path], [data-paperai-change]')).toHaveLength(0)
    expect(band.querySelector('.paperai-conflict-who')?.textContent).toBe('who')
    expect(band.querySelector('.paperai-conflict-legend')?.textContent).toBe('legend')
    const text = band.querySelector('.paperai-conflict-text')!
    expect([...text.children].map(mark => [mark.tagName, mark.textContent]))
      .toEqual([['DEL', '写作'], ['INS', '批改']])
    expect(text.textContent).toBe('本课题旨在构建一个面向中文学位论文的写作批改工作台。')
    expect([...band.querySelectorAll<HTMLButtonElement>('.paperai-conflict-act')]
      .map(button => [button.type, button.dataset.paperaiResolve, button.textContent]))
      .toEqual([['button', 'mine', 'mine'], ['button', 'theirs', 'theirs']])
  })

  it('quotes the document plainly, keeping both sides, when its words are the ones the draft started from', () => {
    // The writer's own edit would otherwise be marked as if the document had made it.
    const theirs = '本课题旨在构建一个面向中文学位论文的写作工作台。'
    const band = conflictBand(document, { ...side('document', '本课题旨在构建一个面向中文学位论文的批改工作台。', theirs), unmarked: true })
    const text = band.querySelector('.paperai-conflict-text')!
    expect(text.querySelectorAll('del, ins')).toHaveLength(0)
    expect(text.textContent).toBe(theirs)
    expect(band.querySelector('.paperai-conflict-legend')?.textContent).toBe('legend')
    expect([...band.querySelectorAll<HTMLElement>('.paperai-conflict-act')].map(button => button.dataset.paperaiResolve))
      .toEqual(['mine', 'theirs'])
  })

  it('marks a long paragraph whose middle only a raised cap can afford', () => {
    // 501×501 cells between the shared ends: past the default, within the band's cap.
    const mine = `甲${'本'.repeat(500)}`
    const theirs = `乙${'本'.repeat(499)}丙`
    const band = conflictBand(document, side('document', mine, theirs))
    expect(band.querySelectorAll('del, ins').length).toBeGreaterThan(0)
    expect(band.querySelector('.paperai-conflict-legend')?.textContent).toBe('legend')
  })

  it('marks what the document changed since the draft began, not what the writer added', () => {
    const base = '本课题旨在构建一个面向中文学位论文的写作工作台。'
    const band = conflictBand(document, side('document', `${base}并支持多人协作。`, base.replace('写作', '批改'), base))
    expect([...band.querySelectorAll('del, ins')].map(mark => [mark.tagName, mark.textContent])).toEqual([['DEL', '写作'], ['INS', '批改']])
    expect(band.textContent).not.toContain('多人协作')
  })

  it('shows the document’s own formatting in an unmarked quotation', () => {
    // A reformat is the change here, so the quotation carries it instead of a word diff that cannot.
    const band = conflictBand(document, { ...side('document', 'Normal bold, and mine', 'Normal bold'), unmarked: true, runs: [
      { text: 'Normal ', size: '16pt' }, { text: 'bold', size: '16pt', bold: true },
    ] })
    const spans = [...band.querySelectorAll<HTMLElement>('.paperai-conflict-text span')]
    expect(spans.map(span => [span.textContent, span.style.fontSize, span.style.fontWeight])).toEqual([['Normal ', '16pt', ''], ['bold', '16pt', 'bold']])
  })

  it('drops the marking and says so when the document kept too little of the draft to mark', () => {
    const theirs = '近年来大模型在文本生成方面取得显著进展，为教育领域带来新机遇。'
    const band = conflictBand(document, side('document', '本课题旨在构建一个面向中文学位论文的写作工作台。', theirs))
    const text = band.querySelector('.paperai-conflict-text')!
    expect(text.querySelectorAll('del, ins')).toHaveLength(0)
    expect(text.textContent).toBe(theirs)
    expect(band.querySelector('.paperai-conflict-legend')?.textContent).toBe('rewritten')
  })

  it('quotes an unreachable draft verbatim and offers copying and discarding in place of a merge', () => {
    const mine = '本课题旨在构建一个面向中文学位论文的写作工作台。'
    const band = conflictBand(document, side('draft', mine, '近年来大模型在文本生成方面取得显著进展。'))
    expect(band.dataset.paperaiConflictForm).toBe('draft')
    const text = band.querySelector('.paperai-conflict-text')!
    expect(text.querySelectorAll('del, ins')).toHaveLength(0)
    expect(text.textContent).toBe(mine)
    expect(band.querySelector('.paperai-conflict-legend')?.textContent).toBe('legend')
    expect([...band.querySelectorAll<HTMLElement>('.paperai-conflict-act')].map(button => button.dataset.paperaiResolve))
      .toEqual(['copy', 'drop'])
  })

  it.each([['document', '草稿还在这里', '', ''], ['draft', '', '文档现在的写法', 'legend']] as const)(
    'stands a placeholder in for the side a %s band would otherwise quote as a blank line', (form, mine, theirs, legend) => {
      const band = conflictBand(document, side(form, mine, theirs))
      const text = band.querySelector('.paperai-conflict-text')!
      expect(text.textContent).toBe('empty')
      expect(text.classList.contains('paperai-conflict-empty')).toBe(true)
      // Nothing is marked, so a document band drops its legend; a draft band's legend is its only reason.
      expect(band.querySelector('.paperai-conflict-legend')?.textContent).toBe(legend)
    })

  it('keeps an unmarked band’s reason when the side it quotes is empty', () => {
    // Two empty paragraphs are exactly where recurring words ask for the place to be confirmed.
    const band = conflictBand(document, { ...side('document', '第一章的正文', ''), unmarked: true })
    expect(band.querySelector('.paperai-conflict-text')!.textContent).toBe('empty')
    expect(band.querySelector('.paperai-conflict-legend')?.textContent).toBe('legend')
  })

  it('dresses an empty paragraph\u2019s placeholder in the document\u2019s formatting', () => {
    // Its formatting may be the only difference the writer is asked to settle.
    const band = conflictBand(document, { ...side('document', '', ''), unmarked: true, runs: [{ text: '', size: '16pt', bold: true }] })
    const span = band.querySelector<HTMLElement>('.paperai-conflict-text span')!
    expect([span.textContent, span.style.fontSize, span.style.fontWeight]).toEqual(['empty', '16pt', 'bold'])
  })

  it('shows soft breaks and split paragraphs as line breaks, and names itself for assistive technology', () => {
    const band = conflictBand(document, side('draft', '第一段草稿\v软换行\n第二段草稿', '文档'))
    expect(band.querySelector('.paperai-conflict-text')!.textContent).toBe('第一段草稿\n软换行\n第二段草稿')
    expect(band.getAttribute('role')).toBe('group')
    expect(band.getAttribute('aria-label')).toBe('label')
  })
})
