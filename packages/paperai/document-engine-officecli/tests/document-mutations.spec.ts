import { DOMParser, XMLSerializer, type Element as XmlElement } from '@xmldom/xmldom'
import type { EngineMutation } from '@paperai/document-engine'
import { describe, expect, it, vi } from 'vitest'
import { applyDocumentMutations as applyBatch } from '../src/document-mutations.ts'
import { resolveOfficePath } from '../src/office-path.ts'
import { replaceParagraphXml } from '../src/paragraph-xml.ts'

vi.mock('../src/office-path.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/office-path.ts')>()
  return { ...actual, resolveOfficePath: vi.fn(actual.resolveOfficePath) }
})

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const document = (body: string) => new DOMParser().parseFromString(
  `<w:document xmlns:w="${WORD_NS}"><w:body>${body}</w:body></w:document>`, 'application/xml',
).documentElement!
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const texts = (root: XmlElement) => Array.from(resolveOfficePath(root, '/body').childNodes)
  .filter((node): node is XmlElement => node.nodeType === node.ELEMENT_NODE && node.localName === 'p')
  .map(node => node.textContent)
const replace = (group: readonly [XmlElement, ...XmlElement[]], mutation: Extract<EngineMutation, { type: 'replace-text' }>) =>
  replaceParagraphXml(group, mutation, style => style)
// Stands in for OfficeCLI's text index: every addressable body paragraph read as its plain text.
const bodyIndex = (root: XmlElement) => Array.from(root.getElementsByTagNameNS(WORD_NS, 'p'), (_, index) => `/body/p[${index + 1}]`)
  .flatMap((officePath) => {
    try {
      return [{ officePath, text: resolveOfficePath(root, officePath).textContent ?? '' }]
    } catch {
      return []
    }
  })
const applyDocumentMutations = (root: XmlElement, mutations: readonly EngineMutation[], edit: typeof replace,
  indexed = bodyIndex(root), styles?: XmlElement) => { applyBatch(root, mutations, indexed, edit, style => style, styles) }
const numberingStyles = new DOMParser().parseFromString(`<w:styles xmlns:w="${WORD_NS}">`
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading2"><w:basedOn w:val="Heading1"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="a9"><w:pPr><w:ind w:firstLine="480"/></w:pPr></w:style></w:styles>', 'application/xml',
).documentElement!

describe('ordered candidate document mutations', () => {
  it('keeps later original targets stable when an earlier original paragraph splits', () => {
    const root = document(paragraph('alpha') + paragraph('beta') + paragraph('gamma'))
    applyDocumentMutations(root, [
      { baseText: 'alpha', type: 'replace-text', officePath: '/body/p[1]', text: 'first\ninserted', paragraphs: [{ text: 'first' }, { text: 'inserted' }] },
      { baseText: 'beta', type: 'replace-text', officePath: '/body/p[2]', text: 'beta edited' },
    ], replace)
    expect(texts(root)).toEqual(['first', 'inserted', 'beta edited', 'gamma'])
  })

  it.each<[EngineMutation, (string | null)[]]>([
    [{ baseText: 'first\nsecond', type: 'replace-text', officePath: '/body/p[1]', text: 'one\ntwo\nthree' }, ['one', 'two', 'three', 'beta']],
    [{ baseText: 'first\nsecond', type: 'replace-text', officePath: '/body/p[1]', text: 'merged' }, ['merged', 'beta']],
    [{ baseText: 'first\nsecond', type: 'remove', officePath: '/body/p[1]' }, ['beta']],
    [{ baseText: 'first\nsecond', type: 'insert-paragraph', after: '/body/p[1]', text: 'after' }, ['first', 'second', 'after', 'beta']],
    [{ baseText: 'first\nsecond', type: 'insert-paragraph', before: '/body/p[1]', text: 'before' }, ['before', 'first', 'second', 'beta']],
  ])('treats every paragraph of an earlier split as the original node for a later $type', (mutation, expected) => {
    const root = document(paragraph('alpha') + paragraph('beta'))
    applyDocumentMutations(root, [
      { baseText: 'alpha', type: 'replace-text', officePath: '/body/p[1]', text: 'first\nsecond' },
      mutation,
    ], replace)
    expect(texts(root)).toEqual(expected)
  })

  it('keeps paragraph properties by position and the section break last when a split paragraph is replaced again', () => {
    const root = document(`<w:p><w:pPr><w:sectPr><w:pgSz w:w="123"/></w:sectPr></w:pPr><w:r><w:t>alpha</w:t></w:r></w:p>${paragraph('beta')}`)
    applyDocumentMutations(root, [
      { baseText: 'alpha', type: 'replace-text', officePath: '/body/p[1]', text: 'title\nbody',
        paragraphs: [{ text: 'title', format: { style: 'Heading1' } }, { text: 'body' }] },
      { baseText: 'title\nbody', type: 'replace-text', officePath: '/body/p[1]', text: 'title\nbody\nmore' },
    ], replace)
    expect(texts(root)).toEqual(['title', 'body', 'more', 'beta'])
    const paragraphs = Array.from(root.getElementsByTagNameNS(WORD_NS, 'p'))
    expect(paragraphs.map(node => node.getElementsByTagNameNS(WORD_NS, 'pStyle')[0]?.getAttributeNS(WORD_NS, 'val')))
      .toEqual(['Heading1', undefined, undefined, undefined])
    expect(paragraphs.map(node => node.getElementsByTagNameNS(WORD_NS, 'sectPr').length)).toEqual([0, 0, 1, 0])
  })

  it.each<[string, (baseText: string) => EngineMutation, string[]]>([
    ['removal', baseText => ({ baseText, type: 'remove', officePath: '/body/p[1]' }), ['beta']],
    ['insertion after', baseText => ({ baseText, type: 'insert-paragraph', after: '/body/p[1]', text: 'inserted' }),
      ['eq x=1', 'inserted', 'beta']],
    ['insertion before', baseText => ({ baseText, type: 'insert-paragraph', before: '/body/p[1]', text: 'inserted' }),
      ['inserted', 'eq x=1', 'beta']],
  ])('identifies the %s target by the engine index, including content the editor cannot project', (_label, mutation, expected) => {
    const equation = '<w:p xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:r><w:t xml:space="preserve">eq </w:t></w:r>'
      + '<m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath></w:p>'
    const indexed = [{ officePath: '/body/p[1]', text: 'eq x=1' }, { officePath: '/body/p[2]', text: 'beta' }]
    const root = document(equation + paragraph('beta'))
    applyDocumentMutations(root, [mutation('eq x=1')], replace, indexed)
    expect(texts(root)).toEqual(expected)
    for (const stale of ['eq ', 'eq x=2']) {
      expect(() => { applyDocumentMutations(document(equation), [mutation(stale)], replace, indexed) }).toThrow('NODE_TEXT_CONFLICT')
    }
    expect(() => { applyDocumentMutations(document(equation), [mutation('eq x=1')], replace, []) }).toThrow('INVALID_OFFICE_PATH')
    expect(() => {
      applyDocumentMutations(document(equation), [{ baseText: 'eq x=1', type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }], replace, indexed)
    }).toThrow('UNSUPPORTED_DOCUMENT_CONTENT')
  })

  it.each<EngineMutation>([
    { baseText: 'alpha', type: 'remove', officePath: '/body/p[1]' },
    { baseText: 'alpha', type: 'insert-paragraph', after: '/body/p[1]', text: 'inserted' },
    { baseText: '[Table: 2 rows]', type: 'remove', officePath: '/body/tbl[1]' },
  ])('rejects $type when the XML target it can read disagrees with the index entry for its address', (mutation) => {
    const root = document(paragraph('beta') + `<w:tbl><w:tr><w:tc>${paragraph('cell')}</w:tc></w:tr></w:tbl>`)
    const indexed = [{ officePath: '/body/p[1]', text: 'alpha' }, { officePath: '/body/tbl[1]', text: '[Table: 2 rows]' }]
    expect(() => { applyDocumentMutations(root, [mutation], replace, indexed) }).toThrow('NODE_TEXT_CONFLICT')
    expect(texts(root)).toEqual(['beta'])
  })

  it.each<[string, string]>([
    ['direct numbering', '<w:numPr><w:numId w:val="1"/></w:numPr>'],
    ['a numbered paragraph style', '<w:pStyle w:val="Heading1"/>'],
    ['a style based on a numbered style', '<w:pStyle w:val="Heading2"/>'],
    ['a numbered style and a direct level only', '<w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="1"/></w:numPr>'],
  ])('identifies a paragraph with %s by the engine reading that carries its generated marker', (_label, properties) => {
    const numbered = `<w:p><w:pPr>${properties}</w:pPr><w:r><w:t>item one</w:t></w:r></w:p>`
    const indexed = [{ officePath: '/body/p[1]', text: '1. item one' }, { officePath: '/body/p[2]', text: 'beta' }]
    const root = document(numbered + paragraph('beta'))
    applyDocumentMutations(root, [
      { baseText: '1. item one', type: 'insert-paragraph', after: '/body/p[1]', text: 'inserted' },
      { baseText: '1. item one', type: 'remove', officePath: '/body/p[1]' },
    ], replace, indexed, numberingStyles)
    expect(texts(root)).toEqual(['inserted', 'beta'])
    expect(() => {
      applyDocumentMutations(document(numbered), [{ baseText: 'item one', type: 'remove', officePath: '/body/p[1]' }], replace, indexed, numberingStyles)
    }).toThrow('NODE_TEXT_CONFLICT')
    // Without numbering, a longer engine reading is a different paragraph, not a marker.
    expect(() => {
      applyDocumentMutations(document(paragraph('item one')), [{ baseText: '1. item one', type: 'remove', officePath: '/body/p[1]' }], replace, indexed)
    }).toThrow('NODE_TEXT_CONFLICT')
  })

  it.each<[string, string]>([
    ['an unnumbered paragraph style', '<w:pPr><w:pStyle w:val="a9"/></w:pPr><w:r><w:t>item one</w:t></w:r>'],
    ['an unnumbered paragraph style and no text', '<w:pPr><w:pStyle w:val="a9"/></w:pPr>'],
    ['style numbering removed by numId 0', '<w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:t>item one</w:t></w:r>'],
    ['numbering only in tracked-change history', '<w:pPr><w:pPrChange w:id="1"><w:pPr><w:pStyle w:val="Heading1"/>'
      + '<w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:pPrChange></w:pPr><w:r><w:t>item one</w:t></w:r>'],
  ])('keeps the exact agreement check for a paragraph with %s', (_label, content) => {
    const root = document(`<w:p>${content}</w:p>`)
    expect(() => {
      applyDocumentMutations(root, [{ baseText: '1. item one', type: 'remove', officePath: '/body/p[1]' }], replace,
        [{ officePath: '/body/p[1]', text: '1. item one' }], numberingStyles)
    }).toThrow('NODE_TEXT_CONFLICT')
    expect(root.getElementsByTagNameNS(WORD_NS, 'p')).toHaveLength(1)
  })

  it.each<[string, string]>([['/body/p[01]', 'alpha'], ['/body/tbl', '[Table: 1 rows]']])(
    'names %s as an address spelling OfficeCLI does not index instead of a stale-text conflict', (officePath, baseText) => {
      const root = document(paragraph('alpha') + `<w:tbl><w:tr><w:tc>${paragraph('cell')}</w:tc></w:tr></w:tbl>`)
      const indexed = [{ officePath: '/body/p[1]', text: 'alpha' }, { officePath: '/body/tbl[1]', text: '[Table: 1 rows]' }]
      expect(() => { applyDocumentMutations(root, [{ baseText, type: 'remove', officePath }], replace, indexed) })
        .toThrow(`INVALID_OFFICE_PATH: '${officePath}' is not an address in OfficeCLI's text index; use the officePath readTextNodes reports`)
      expect(texts(root)).toEqual(['alpha'])
    },
  )

  it('finds the engine reading of an ordinal target under the paraId address the engine indexed it by', () => {
    const root = document('<w:p xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" w14:paraId="0A1B2C3D">'
      + '<w:r><w:t>alpha</w:t></w:r></w:p>' + paragraph('beta'))
    applyDocumentMutations(root, [{ baseText: 'alpha', type: 'remove', officePath: '/document/body/p[1]' }], replace,
      [{ officePath: '/body/p[@paraId=0A1B2C3D]', text: 'alpha' }])
    expect(texts(root)).toEqual(['beta'])
  })

  it('looks up only its own targets in the text index instead of resolving every entry', () => {
    const root = document(paragraph('alpha') + paragraph('beta'))
    const indexed = Array.from({ length: 500 }, (_, index) => ({ officePath: `/body/p[${index + 1}]`, text: index === 0 ? 'alpha' : 'other' }))
    vi.mocked(resolveOfficePath).mockClear()
    applyDocumentMutations(root, [{ baseText: 'alpha', type: 'remove', officePath: '/body/p[1]' }], replace, indexed)
    // The body lookup; the target binding happens inside the path module.
    expect(resolveOfficePath).toHaveBeenCalledOnce()
    expect(texts(root)).toEqual(['beta'])
  })

  it('preserves request order for repeated anchors, repeated replacement, and removal', () => {
    const root = document(paragraph('alpha') + paragraph('beta') + paragraph('gamma'))
    applyDocumentMutations(root, [
      { baseText: 'alpha', type: 'insert-paragraph', after: '/body/p[1]', text: 'after A one' },
      { baseText: 'alpha', type: 'insert-paragraph', after: '/body/p[1]', text: 'after A two' },
      { baseText: 'beta', type: 'insert-paragraph', before: '/body/p[2]', text: 'before B' },
      { baseText: 'alpha', type: 'remove', officePath: '/body/p[1]' },
      { baseText: 'beta', type: 'replace-text', officePath: '/body/p[2]', text: 'beta intermediate' },
      { baseText: 'beta intermediate', type: 'replace-text', officePath: '/body/p[2]', text: 'beta final' },
      { baseText: 'gamma', type: 'replace-text', officePath: '/body/p[3]', text: 'gamma final' },
    ], replace)
    expect(texts(root)).toEqual(['after A two', 'after A one', 'before B', 'beta final', 'gamma final'])
  })

  it('rejects an invalid later reference before invoking any paragraph replacement', () => {
    const root = document(paragraph('alpha'))
    const edit = vi.fn(replace)
    expect(() =>{  applyDocumentMutations(root, [
      { baseText: 'alpha', type: 'replace-text', officePath: '/body/p[1]', text: 'edited' },
      { baseText: 'beta', type: 'remove', officePath: '/body/p[2]' },
    ], edit) }).toThrow('INVALID_OFFICE_PATH')
    expect(edit).not.toHaveBeenCalled()
    expect(texts(root)).toEqual(['alpha'])
  })

  it.each<EngineMutation>([
    { baseText: 'alpha', type: 'replace-text', officePath: '/body/p[1]', text: 'gone' },
    { baseText: 'alpha', type: 'remove', officePath: '/body/p[1]' },
    { baseText: 'alpha', type: 'insert-paragraph', after: '/body/p[1]', text: 'after gone' },
    { baseText: 'alpha', type: 'insert-paragraph', before: '/body/p[1]', text: 'before gone' },
  ])('rejects $type on an original node removed earlier', (mutation) => {
    const root = document(paragraph('alpha') + paragraph('beta'))
    expect(() =>{  applyDocumentMutations(root, [{ baseText: 'alpha', type: 'remove', officePath: '/body/p[1]' }, mutation], replace) })
      .toThrow('INVALID_OFFICE_TARGET')
    expect(texts(root)).toEqual(['beta'])
  })

  it('rejects a table descendant after removal of its original ancestor', () => {
    const root = document(`<w:tbl><w:tr><w:tc>${paragraph('cell')}</w:tc></w:tr></w:tbl>`)
    expect(() =>{  applyDocumentMutations(root, [
      { baseText: '[Table: 1 rows]', type: 'remove', officePath: '/body/tbl[1]' },
      { baseText: '[Table: 1 rows]', type: 'replace-text', officePath: '/body/tbl[1]/tr[1]/tc[1]/p[1]', text: 'gone' },
    ], replace, [{ officePath: '/body/tbl[1]', text: '[Table: 1 rows]' }]) }).toThrow('INVALID_OFFICE_TARGET')
  })

  it('inserts beside a nested paragraph and resolves later references in the same original cell', () => {
    const root = document(`<w:tbl><w:tr><w:tc>${paragraph('one')}${paragraph('two')}</w:tc></w:tr></w:tbl>`)
    applyDocumentMutations(root, [
      { baseText: 'one', type: 'insert-paragraph', after: '/body/tbl[1]/tr[1]/tc[1]/p[1]', text: 'inserted' },
      { baseText: 'two', type: 'replace-text', officePath: '/body/tbl[1]/tr[1]/tc[1]/p[2]', text: 'two edited' },
    ], replace, [{ officePath: '/body/tbl[1]/tr[1]/tc[1]/p[1]', text: 'one' }])
    const cell = resolveOfficePath(root, '/body/tbl[1]/tr[1]/tc[1]')
    expect(Array.from(cell.childNodes).map(node => node.textContent)).toEqual(['one', 'inserted', 'two edited'])
  })

  it('appends before final section properties and interprets later indices in the current mixed body', () => {
    const root = document(`\n${paragraph('original')}<w:tbl/><w:sectPr><w:pgSz w:w="123"/></w:sectPr>`)
    const section = resolveOfficePath(root, '/body').lastChild
    applyDocumentMutations(root, [
      { type: 'insert-paragraph', text: 'appended' },
      { type: 'insert-paragraph', text: 'before table', index: 1 },
      { type: 'insert-paragraph', text: 'prepended', index: 0 },
    ], replace)
    expect(texts(root)).toEqual(['prepended', 'original', 'before table', 'appended'])
    expect(resolveOfficePath(root, '/body').lastChild).toBe(section)
    expect(new XMLSerializer().serializeToString(section!)).toContain('w:w="123"')
  })

  it.each<EngineMutation>([
    { baseText: '[Table: 1 rows]', type: 'insert-paragraph', after: '/body/tbl[1]/tr[1]', text: 'invalid table child' },
    { baseText: '[Table: 1 rows]', type: 'insert-paragraph', before: '/body/tbl[1]/tr[1]/tc[1]', text: 'invalid row child' },
  ])('rejects paragraph insertion beside a row or cell: $after $before', (mutation) => {
    const root = document(`<w:tbl><w:tr><w:tc>${paragraph('cell')}</w:tc></w:tr></w:tbl>`)
    const before = new XMLSerializer().serializeToString(root)
    expect(() => { applyDocumentMutations(root, [mutation], replace) }).toThrow('INVALID_INSERT_POSITION')
    expect(new XMLSerializer().serializeToString(root)).toBe(before)
  })

  it('preserves plain text whitespace, tabs, soft breaks, style IDs, and multiple paragraph boundaries', () => {
    const root = document('')
    applyDocumentMutations(root, [{ type: 'insert-paragraph', text: ' a & b\t中\v文 \r\n\rfinal', style: 'Heading1' }], replace)
    const paragraphs = Array.from(resolveOfficePath(root, '/body').childNodes) as XmlElement[]
    expect(paragraphs).toHaveLength(3)
    expect(paragraphs[0]?.getElementsByTagNameNS(WORD_NS, 'tab')).toHaveLength(1)
    expect(paragraphs[0]?.getElementsByTagNameNS(WORD_NS, 'br')).toHaveLength(1)
    expect(paragraphs[0]?.getElementsByTagNameNS(WORD_NS, 't')[0]?.textContent).toBe(' a & b')
    expect(paragraphs[0]?.getElementsByTagNameNS(WORD_NS, 't')[0]?.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space')).toBe('preserve')
    expect(paragraphs.map(node => node.getElementsByTagNameNS(WORD_NS, 'pStyle')[0]?.getAttributeNS(WORD_NS, 'val'))).toEqual(['Heading1', 'Heading1', 'Heading1'])
    expect(paragraphs[1]?.textContent).toBe('')
    expect(paragraphs[2]?.textContent).toBe('final')
  })

  it.each<EngineMutation>([
    { type: 'insert-paragraph', text: 'bad', index: -1 },
    { type: 'insert-paragraph', text: 'bad', index: 0.5 },
    { type: 'insert-paragraph', text: 'bad', index: 2 },
    // Statically rejected (one position per insertion); the runtime check stays for dynamic callers.
    { baseText: 'alpha', type: 'insert-paragraph', text: 'bad', after: '/body/p[1]', before: '/body/p[1]' } as unknown as EngineMutation,
    { baseText: 'alpha', type: 'insert-paragraph', text: 'bad', after: '/body/p[1]', index: 0 } as unknown as EngineMutation,
  ])('rejects invalid insertion positions: $index $after $before', (mutation) => {
    const root = document(paragraph('alpha'))
    expect(() =>{  applyDocumentMutations(root, [mutation], replace) }).toThrow('INVALID_INSERT_POSITION')
    expect(texts(root)).toEqual(['alpha'])
  })

  it('prevents removing the body container and propagates paragraph editor failures', () => {
    const root = document(paragraph('alpha'))
    expect(() =>{  applyDocumentMutations(root, [{ baseText: 'alpha', type: 'remove', officePath: '/body' }], replace) }).toThrow('INVALID_OFFICE_TARGET')
    expect(() =>{  applyDocumentMutations(root, [{ baseText: 'alpha', type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }], () => {
      throw new Error('paragraph blocked')
    }) }).toThrow('paragraph blocked')
    expect(texts(root)).toEqual(['alpha'])
  })

  it('rejects replacement text addressed to a table container', () => {
    const root = document('<w:tbl/>')
    const edit = vi.fn(replace)
    expect(() => {
      applyDocumentMutations(root, [{ baseText: '[Table: 1 rows]', type: 'replace-text', officePath: '/body/tbl[1]', text: 'bad' }], edit)
    }).toThrow('INVALID_OFFICE_TARGET')
    expect(edit).not.toHaveBeenCalled()
  })

  it('refuses removal of a structural node without an indexed text projection', () => {
    const root = document('<w:tbl><w:tr><w:tc>' + paragraph('cell') + '</w:tc></w:tr></w:tbl>')
    expect(() => {
      applyDocumentMutations(root, [
        { type: 'remove', officePath: '/body/tbl[1]/tr[1]', baseText: 'cell' },
      ], replace)
    }).toThrow('INVALID_OFFICE_PATH')
    expect(root.getElementsByTagNameNS(WORD_NS, 'tr')).toHaveLength(1)
  })

  it('resolves one explicit style for all inserted paragraphs before changing the body', () => {
    const root = document('')
    const resolveStyle = vi.fn(() => 'Heading1')
    applyBatch(root, [{ type: 'insert-paragraph', text: 'one\ntwo', style: 'Heading 1' }], [], replace, resolveStyle)
    expect(resolveStyle).toHaveBeenCalledExactlyOnceWith('Heading 1')
    expect(Array.from(root.getElementsByTagNameNS(WORD_NS, 'pStyle')).map(node => node.getAttributeNS(WORD_NS, 'val')))
      .toEqual(['Heading1', 'Heading1'])
    expect(() =>{  applyBatch(root, [{ type: 'insert-paragraph', text: 'bad', style: 'Unknown' }], [], replace, () => {
      throw new Error('style does not exist')
    }) }).toThrow('style does not exist')
    expect(texts(root)).toEqual(['one', 'two'])
  })
})
