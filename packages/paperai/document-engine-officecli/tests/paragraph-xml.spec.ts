import { DOMParser, XMLSerializer, type Element as XmlElement } from '@xmldom/xmldom'
import { describe, expect, it, vi } from 'vitest'
import { formatParagraph, replaceParagraphXml } from '../src/paragraph-xml.ts'
import type { EngineMutation } from '@paperai/document-engine'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
const RPR = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="SimSun" w:cs="Amiri" w:hint="eastAsia"/>'
  + '<w:b/><w:i w:val="0"/><w:color w:val="12AB34" w:themeColor="accent1" w:themeTint="80"/>'
  + '<w:spacing w:val="15"/><w:kern w:val="24"/><w:sz w:val="24"/><w:szCs w:val="28"/>'
  + '<w:u w:val="double" w:color="FF0000"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr>'

function document(body: string): XmlElement {
  return new DOMParser().parseFromString(`<w:document xmlns:w="${W}" xmlns:w14="${W14}" xmlns:x="urn:opaque">`
    + `<w:body>${body}</w:body></w:document>`, 'application/xml').documentElement!
}

function all(node: XmlElement, name: string): XmlElement[] {
  return Array.from(node.getElementsByTagNameNS(W, name))
}

function xml(node: XmlElement): string {
  return new XMLSerializer().serializeToString(node)
}

function text(node: XmlElement): string {
  return all(node, 't').map(item => item.textContent).join('')
}

function edit(paragraph: XmlElement, mutation: Omit<Extract<EngineMutation, { type: 'replace-text' }>, 'type' | 'officePath'>): void {
  replaceParagraphXml(paragraph, { type: 'replace-text', officePath: '/body/p[1]', ...mutation }, name => name)
}

describe('paragraph XML text and formatting', () => {
  it('retains each source run metadata through several edits in one paragraph', () => {
    const root = document('<w:p w14:paraId="ABCDEF12"><w:pPr><w:keepNext/></w:pPr>'
      + `<w:r w:rsidRPr="11223344">${RPR}<w:t>cat </w:t></w:r>`
      + '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>walks </w:t></w:r>'
      + '<w:r><w:rPr><w:i/><w:lang w:val="fr-FR"/></w:rPr><w:t>home.</w:t></w:r></w:p>')
    const paragraph = all(root, 'p')[0]!
    const source = all(paragraph, 'r').map(run => xml(all(run, 'rPr')[0]!))
    edit(paragraph, { text: 'dog walks home!' })
    expect(text(paragraph)).toBe('dog walks home!')
    expect(all(root, 'p')[0]).toBe(paragraph)
    expect(paragraph.getAttributeNS(W14, 'paraId')).toBe('ABCDEF12')
    const runs = all(paragraph, 'r')
    expect(runs.map(run => text(run)).join('')).toBe('dog walks home!')
    expect(xml(all(runs.find(run => text(run).includes('dog'))!, 'rPr')[0]!)).toBe(source[0])
    expect(xml(all(runs.find(run => text(run).includes('walks'))!, 'rPr')[0]!)).toBe(source[1])
    expect(xml(all(runs.find(run => text(run).includes('home'))!, 'rPr')[0]!)).toBe(source[2])
    expect(runs[0]!.getAttributeNS(W, 'rsidRPr')).toBe('11223344')
    expect(all(paragraph, 'keepNext')).toHaveLength(1)
  })

  it('retains unrepresented properties when explicit values match the displayed formatting', () => {
    const root = document(`<w:p><w:r>${RPR}<w:t>文A</w:t></w:r></w:p>`)
    const paragraph = all(root, 'p')[0]!
    const before = xml(all(paragraph, 'rPr')[0]!)
    edit(paragraph, { text: '文A', runs: [{ text: '文A', font: 'SimSun', size: '12pt', color: '#12ab34', bold: true, italic: false, underline: true }] })
    expect(xml(all(paragraph, 'rPr')[0]!)).toBe(before)
  })

  it('changes explicit font, size, color and emphasis while retaining other run metadata', () => {
    const root = document(`<w:p><w:r>${RPR}<w:t>text</w:t></w:r></w:p>`)
    const paragraph = all(root, 'p')[0]!
    edit(paragraph, { text: 'text', runs: [{ text: 'text', font: 'Calibri', size: '16pt', color: '#abcdef', bold: false, italic: true, underline: false }] })
    const fonts = all(paragraph, 'rFonts')[0]!
    expect(['ascii', 'hAnsi', 'eastAsia'].map(name => fonts.getAttributeNS(W, name))).toEqual(['Calibri', 'Calibri', 'Calibri'])
    expect(fonts.getAttributeNS(W, 'cs')).toBe('Amiri')
    expect(fonts.getAttributeNS(W, 'hint')).toBe('eastAsia')
    for (const name of ['sz', 'szCs']) expect(all(paragraph, name)[0]!.getAttributeNS(W, 'val')).toBe('32')
    expect(all(paragraph, 'color')[0]!.getAttributeNS(W, 'val')).toBe('ABCDEF')
    expect(all(paragraph, 'color')[0]!.hasAttributeNS(W, 'themeColor')).toBe(false)
    expect(all(paragraph, 'color')[0]!.hasAttributeNS(W, 'themeTint')).toBe(false)
    expect(all(paragraph, 'b')[0]!.getAttributeNS(W, 'val')).toBe('0')
    expect(all(paragraph, 'i')[0]!.getAttributeNS(W, 'val')).toBe('1')
    expect(all(paragraph, 'u')[0]!.getAttributeNS(W, 'val')).toBe('none')
    expect(all(paragraph, 'kern')[0]!.getAttributeNS(W, 'val')).toBe('24')
    expect(all(paragraph, 'spacing')[0]!.getAttributeNS(W, 'val')).toBe('15')
    expect(all(paragraph, 'lang')[0]!.getAttributeNS(W, 'eastAsia')).toBe('zh-CN')
  })

  it('clears Latin and East Asian fonts without removing hint or complex-script metadata', () => {
    const root = document('<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="SimSun"'
      + ' w:asciiTheme="majorAscii" w:hAnsiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:cs="Amiri" w:hint="eastAsia"/>'
      + '</w:rPr><w:t>mixed</w:t></w:r></w:p>')
    const paragraph = all(root, 'p')[0]!
    edit(paragraph, { text: 'mixed', runs: [{ text: 'mixed', font: '' }] })
    const fonts = all(paragraph, 'rFonts')[0]!
    for (const name of ['ascii', 'hAnsi', 'eastAsia', 'asciiTheme', 'hAnsiTheme', 'eastAsiaTheme']) expect(fonts.hasAttributeNS(W, name)).toBe(false)
    expect(fonts.getAttributeNS(W, 'cs')).toBe('Amiri')
    expect(fonts.getAttributeNS(W, 'hint')).toBe('eastAsia')
  })

  it('adds explicit formatting to plain text and leaves omitted formatting unset', () => {
    const root = document('<w:p><w:r><w:t>ab</w:t></w:r></w:p>')
    const paragraph = all(root, 'p')[0]!
    edit(paragraph, { text: 'ab', runs: [{ text: 'a', bold: true, italic: false, underline: true }, { text: 'b' }] })
    const runs = all(paragraph, 'r')
    expect(all(runs[0]!, 'b')[0]!.getAttributeNS(W, 'val')).toBe('1')
    expect(all(runs[0]!, 'i')[0]!.getAttributeNS(W, 'val')).toBe('0')
    expect(all(runs[0]!, 'u')[0]!.getAttributeNS(W, 'val')).toBe('single')
    expect(all(runs[1]!, 'rPr')).toEqual([])
  })

  it('retains tabs, soft breaks, supplementary characters and significant spaces', () => {
    const root = document('<w:p><w:r><w:t>before</w:t></w:r></w:p>')
    const paragraph = all(root, 'p')[0]!
    edit(paragraph, { text: ' A\t😀\vB ', runs: [{ text: ' A\t😀\vB ' }] })
    expect(text(paragraph)).toBe(' A😀B ')
    expect(all(paragraph, 'tab')).toHaveLength(1)
    expect(all(paragraph, 'br')).toHaveLength(1)
    expect(all(paragraph, 't').every(node => node.getAttribute('xml:space') === 'preserve')).toBe(true)
  })

  it.each(['left', 'right', 'all'])('retains clear=%s on a matched soft break without adding another break', (clear) => {
    const root = document(`<w:p><w:r>${RPR}<w:t>before</w:t><w:br w:type="textWrapping" w:clear="${clear}"/>`
      + '<w:t>after</w:t></w:r></w:p>')
    const paragraph = all(root, 'p')[0]!
    edit(paragraph, { text: 'before\vafter!', runs: [{ text: 'before\vafter!', italic: true }] })
    const breaks = all(paragraph, 'br')
    expect(breaks).toHaveLength(1)
    expect(breaks[0]!.getAttributeNS(W, 'clear')).toBe(clear)
    expect(breaks[0]!.getAttributeNS(W, 'type')).toBe('textWrapping')
    const run = breaks[0]!.parentNode as XmlElement
    expect(all(run, 'i')[0]!.getAttributeNS(W, 'val')).toBe('1')
    expect(all(run, 'kern')[0]!.getAttributeNS(W, 'val')).toBe('24')
    expect(text(paragraph)).toBe('beforeafter!')
    edit(paragraph, { text: 'beforeafter!' })
    expect(all(paragraph, 'br')).toHaveLength(0)
  })
})

describe('paragraph markers and splits', () => {
  it('moves bookmark and permission ranges with edited text and retains hard and rendered breaks once', () => {
    const root = document('<w:p><w:r><w:t>lead</w:t></w:r><w:bookmarkStart w:id="7" w:name="range"/>'
      + '<w:permStart w:id="8"/><w:proofErr w:type="spellStart"/>'
      + `<w:r>${RPR}<w:br w:type="page"/><w:t>AB</w:t><w:br w:type="column"/><w:lastRenderedPageBreak/></w:r>`
      + '<w:proofErr w:type="spellEnd"/><w:permEnd w:id="8"/><w:bookmarkEnd w:id="7"/><w:r><w:t>tail</w:t></w:r></w:p>')
    const paragraph = all(root, 'p')[0]!
    edit(paragraph, { text: 'long leadAXBtail!' })
    expect(text(paragraph)).toBe('long leadAXBtail!')
    expect(all(paragraph, 'br').map(node => [node.getAttributeNS(W, 'type'), node.getAttributeNS(W, 'clear')])).toEqual([
      ['page', null], ['column', null],
    ])
    expect(all(paragraph, 'lastRenderedPageBreak')).toHaveLength(1)
    for (const name of ['bookmarkStart', 'bookmarkEnd', 'permStart', 'permEnd']) expect(all(paragraph, name)).toHaveLength(1)
    const start = all(paragraph, 'bookmarkStart')[0]!
    const end = all(paragraph, 'bookmarkEnd')[0]!
    let range = ''
    for (let node = start.nextSibling; node !== null && node !== end; node = node.nextSibling) {
      if (node.nodeType === node.ELEMENT_NODE) range += text(node as XmlElement)
    }
    expect(range).toBe('AXB')
    expect(all(paragraph, 'bookmarkStart')[0]!.getAttributeNS(W, 'name')).toBe('range')
    for (const marker of [...all(paragraph, 'br'), ...all(paragraph, 'lastRenderedPageBreak')]) {
      expect(xml(all(marker.parentNode as XmlElement, 'rPr')[0]!)).toContain('w:kern w:val="24"')
    }
  })

  it('keeps section settings only on the last split paragraph before tracked paragraph properties', () => {
    const root = document('<w:p w14:paraId="ABCDEF12" w14:textId="12345678"><w:pPr><w:keepLines/>'
      + '<w:sectPr><w:type w:val="continuous"/><w:pgSz w:w="12000"/></w:sectPr>'
      + '<w:pPrChange w:id="1" w:author="review"><w:pPr/></w:pPrChange></w:pPr>'
      + `<w:r>${RPR}<w:t>beforeafter</w:t></w:r></w:p>`)
    const original = all(root, 'p')[0]!
    edit(original, { text: 'before\nafter', paragraphs: [{ text: 'before' }, { text: 'after' }] })
    const paragraphs = all(root, 'p')
    expect(paragraphs.map(text)).toEqual(['before', 'after'])
    expect(paragraphs[0]).toBe(original)
    expect(paragraphs[1]!.hasAttributeNS(W14, 'paraId')).toBe(false)
    expect(paragraphs[1]!.hasAttributeNS(W14, 'textId')).toBe(false)
    expect(all(paragraphs[0]!, 'sectPr')).toHaveLength(0)
    const properties = all(paragraphs[1]!, 'pPr')[0]!
    const names = Array.from(properties.childNodes)
      .filter(node => node.nodeType === node.ELEMENT_NODE).map(node => (node as XmlElement).localName)
    expect(names).toEqual(['keepLines', 'sectPr', 'pPrChange'])
    expect(all(root, 'sectPr')).toHaveLength(1)
    expect(all(root, 'pgSz')[0]!.getAttributeNS(W, 'w')).toBe('12000')
  })

  it.each(['<w:t/>', ''])('uses a formatted empty run when typing into an empty paragraph containing %s', (content) => {
    const root = document(`<w:p><w:r>${RPR}${content}</w:r></w:p>`)
    const paragraph = all(root, 'p')[0]!
    edit(paragraph, { text: 'typed' })
    const typed = all(paragraph, 'r').find(run => text(run) === 'typed')!
    expect(xml(all(typed, 'rPr')[0]!)).toContain('w:ascii="Arial"')
    expect(xml(all(typed, 'rPr')[0]!)).toContain('w:eastAsia="SimSun"')
    expect(all(typed, 'b')).toHaveLength(1)
  })

  it('inherits character defaults into an empty trailing paragraph and its subsequent typed text', () => {
    const root = document(`<w:p><w:r>${RPR}<w:t>before</w:t></w:r></w:p>`)
    edit(all(root, 'p')[0]!, { text: 'before\n', paragraphs: [{ text: 'before' }, { text: '', runs: [] }] })
    const tail = all(root, 'p')[1]!
    expect(all(tail, 'r')).toHaveLength(1)
    edit(tail, { text: 'after' })
    const typed = all(tail, 'r').find(run => text(run) === 'after')!
    expect(all(typed, 'rFonts')[0]!.getAttributeNS(W, 'ascii')).toBe('Arial')
    expect(all(typed, 'rFonts')[0]!.getAttributeNS(W, 'eastAsia')).toBe('SimSun')
    expect(all(typed, 'b')).toHaveLength(1)
  })

  it.each([
    ['mixed formatting', RPR],
    ['hAnsi-only font metadata', '<w:rPr><w:rFonts w:hAnsi="宋体" w:hint="eastAsia"/>'
      + '<w:kern w:val="28"/><w:spacing w:val="15"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr>'],
  ])('inherits the adjacent original run into leading and trailing empty splits with %s', (_name, firstProperties) => {
    const lastProperties = '<w:rPr><w:rFonts w:hAnsi="黑体" w:hint="default"/>'
      + '<w:kern w:val="10"/><w:lang w:val="fr-FR"/></w:rPr>'
    const root = document(`<w:p><w:r>${firstProperties}<w:t>A</w:t></w:r>`
      + `<w:r>${lastProperties}<w:t>B</w:t></w:r></w:p>`)
    const originalProperties = all(root, 'rPr').map(xml)
    edit(all(root, 'p')[0]!, {
      text: '\n\nAB\n', paragraphs: [{ text: '' }, { text: '' }, { text: 'AB' }, { text: '' }],
    })
    const paragraphs = all(root, 'p')
    expect(paragraphs.map(text)).toEqual(['', '', 'AB', ''])
    expect(paragraphs.map(paragraph => all(paragraph, 'rPr').map(xml))).toEqual([
      [originalProperties[0]], [originalProperties[0]], originalProperties, [originalProperties[1]],
    ])
    edit(paragraphs[0]!, { text: 'typed' })
    expect(text(paragraphs[0]!)).toBe('typed')
    const typed = all(paragraphs[0]!, 'r').find(run => text(run) === 'typed')!
    expect(xml(all(typed, 'rPr')[0]!)).toBe(originalProperties[0])
  })

  it('inherits paragraph character properties when an empty paragraph has no run', () => {
    const root = document('<w:p><w:pPr><w:rPr><w:i/></w:rPr></w:pPr></w:p>')
    const paragraph = all(root, 'p')[0]!
    edit(paragraph, { text: 'typed' })
    expect(all(all(paragraph, 'r')[0]!, 'i')).toHaveLength(1)
  })

  it.each([false, true])('splits newline text with explicit runs: %s', (formatted) => {
    const root = document('<w:p><w:r><w:t>old</w:t></w:r></w:p>')
    edit(all(root, 'p')[0]!, { text: 'a\r\nb\rc', ...(formatted ? { runs: [{ text: 'a\r\nb\rc', bold: true }] } : {}) })
    expect(all(root, 'p').map(text)).toEqual(['a', 'b', 'c'])
    if (formatted) expect(all(root, 'p').every(paragraph => all(paragraph, 'b')[0]?.getAttributeNS(W, 'val') === '1')).toBe(true)
  })
})

describe('paragraph layout and protected content', () => {
  it.each([
    ['12pt', '240'], ['16px', '240'], ['1in', '1440'], ['2.54cm', '1440'], ['25.4mm', '1440'],
    ['6pc', '1440'], ['12', '240'], ['-12pt', '-240'],
  ])('converts %s indentation to Word twips without changing its unit meaning', (indent, twips) => {
    const root = document('<w:p/>')
    formatParagraph(all(root, 'p')[0]!, { indent }, name => name)
    expect(all(root, 'ind')[0]!.getAttributeNS(W, 'left')).toBe(twips)
  })

  it.each(['0pt', '-1pt', 'Infinitypt', 'bad', `${'9'.repeat(310)}pt`])('rejects an invalid font size: %s', (size) => {
    const root = document('<w:p><w:r><w:t>text</w:t></w:r></w:p>')
    expect(() => { edit(all(root, 'p')[0]!, { text: 'text', runs: [{ text: 'text', size }] }) }).toThrow('INVALID_DOCUMENT_FORMAT')
  })

  it.each(['0x', '-1x', 'Infinityx', 'bad', '0pt'])('rejects invalid line spacing: %s', (lineSpacing) => {
    const root = document('<w:p/>')
    expect(() => { formatParagraph(all(root, 'p')[0]!, { lineSpacing }, name => name) }).toThrow('INVALID_DOCUMENT_FORMAT')
  })

  it('rejects an indentation that overflows numeric representation', () => {
    const root = document('<w:p/>')
    expect(() => { formatParagraph(all(root, 'p')[0]!, { indent: `${'9'.repeat(310)}pt` }, name => name) }).toThrow('INVALID_DOCUMENT_FORMAT')
  })

  it('updates layout units and styles without altering untouched paragraph settings or text runs', () => {
    const root = document('<w:p><w:pPr><w:spacing w:before="160" w:after="200"/><w:ind w:left="40" w:leftChars="100"'
      + ' w:start="30" w:startChars="80" w:right="60" w:firstLine="240"/><w:widowControl/></w:pPr>'
      + `<w:r>${RPR}<w:t>same</w:t></w:r></w:p>`)
    const paragraph = all(root, 'p')[0]!
    const source = all(paragraph, 'r')[0]!
    const resolveStyle = vi.fn(() => 'Heading1')
    replaceParagraphXml(paragraph, { type: 'replace-text', officePath: '/body/p[1]', text: 'same', paragraphs: [
      { text: 'same', format: { style: 'Heading 1', align: 'justify', indent: '24pt', lineSpacing: '1.5x' } },
    ] }, resolveStyle)
    expect(all(paragraph, 'r')[0]).toBe(source)
    expect(resolveStyle).toHaveBeenCalledWith('Heading 1')
    expect(all(paragraph, 'pStyle')[0]!.getAttributeNS(W, 'val')).toBe('Heading1')
    expect(all(paragraph, 'jc')[0]!.getAttributeNS(W, 'val')).toBe('both')
    const indent = all(paragraph, 'ind')[0]!
    expect(indent.getAttributeNS(W, 'left')).toBe('480')
    expect(indent.getAttributeNS(W, 'firstLine')).toBe('240')
    expect(indent.getAttributeNS(W, 'right')).toBe('60')
    for (const name of ['leftChars', 'start', 'startChars']) expect(indent.hasAttributeNS(W, name)).toBe(false)
    const spacing = all(paragraph, 'spacing')[0]!
    expect(spacing.getAttributeNS(W, 'line')).toBe('360')
    expect(spacing.getAttributeNS(W, 'lineRule')).toBe('auto')
    expect(spacing.getAttributeNS(W, 'before')).toBe('160')
    expect(spacing.getAttributeNS(W, 'after')).toBe('200')
    formatParagraph(paragraph, { align: 'right', lineSpacing: '18pt' }, name => name)
    expect(spacing.getAttributeNS(W, 'line')).toBe('360')
    expect(spacing.getAttributeNS(W, 'lineRule')).toBe('exact')
    expect(all(paragraph, 'jc')[0]!.getAttributeNS(W, 'val')).toBe('right')
  })

  it.each(['<w:fldSimple w:instr="DATE"/>', '<w:hyperlink/>', '<x:object/>', '<w:r><w:drawing/></w:r>', '<w:r><x:content/></w:r>'])
  ('rejects an unsupported object without altering its paragraph: %s', (content) => {
    const root = document(`<w:p><w:r><w:t>old</w:t></w:r>${content}</w:p>`)
    const paragraph = all(root, 'p')[0]!
    const before = xml(paragraph)
    expect(() => { edit(paragraph, { text: 'new' }) }).toThrow('UNSUPPORTED_DOCUMENT_CONTENT')
    expect(xml(paragraph)).toBe(before)
  })
})
