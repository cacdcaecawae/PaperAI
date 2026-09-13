import { DOMParser, XMLSerializer, type Element as XmlElement } from '@xmldom/xmldom'
import type { EngineMutation } from '@paperai/document-engine'
import { describe, expect, it, vi } from 'vitest'
import { applyDocumentMutations as applyBatch } from '../src/document-mutations.ts'
import { resolveOfficePath } from '../src/office-path.ts'

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const document = (body: string) => new DOMParser().parseFromString(
  `<w:document xmlns:w="${WORD_NS}"><w:body>${body}</w:body></w:document>`, 'application/xml',
).documentElement!
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const texts = (root: XmlElement) => Array.from(resolveOfficePath(root, '/body').childNodes)
  .filter((node): node is XmlElement => node.nodeType === node.ELEMENT_NODE && node.localName === 'p')
  .map(node => node.textContent)
const replace = (target: XmlElement, mutation: Extract<EngineMutation, { type: 'replace-text' }>) => {
  const [first, ...rest] = mutation.paragraphs ?? [{ text: mutation.text }]
  target.textContent = first!.text
  const reference = target.nextSibling
  for (const part of rest) {
    const added = target.cloneNode(false) as XmlElement
    added.textContent = part.text
    target.parentNode!.insertBefore(added, reference)
  }
}
const applyDocumentMutations = (root: XmlElement, mutations: readonly EngineMutation[], edit: typeof replace) =>{
  applyBatch(root, mutations, edit, style => style) }

describe('ordered candidate document mutations', () => {
  it('keeps later original targets stable when an earlier original paragraph splits', () => {
    const root = document(paragraph('alpha') + paragraph('beta') + paragraph('gamma'))
    applyDocumentMutations(root, [
      { type: 'replace-text', officePath: '/body/p[1]', text: 'first\ninserted', paragraphs: [{ text: 'first' }, { text: 'inserted' }] },
      { type: 'replace-text', officePath: '/body/p[2]', text: 'beta edited' },
    ], replace)
    expect(texts(root)).toEqual(['first', 'inserted', 'beta edited', 'gamma'])
  })

  it('preserves request order for repeated anchors, repeated replacement, and removal', () => {
    const root = document(paragraph('alpha') + paragraph('beta') + paragraph('gamma'))
    applyDocumentMutations(root, [
      { type: 'insert-paragraph', after: '/body/p[1]', text: 'after A one' },
      { type: 'insert-paragraph', after: '/body/p[1]', text: 'after A two' },
      { type: 'insert-paragraph', before: '/body/p[2]', text: 'before B' },
      { type: 'remove', officePath: '/body/p[1]' },
      { type: 'replace-text', officePath: '/body/p[2]', text: 'beta intermediate' },
      { type: 'replace-text', officePath: '/body/p[2]', text: 'beta final' },
      { type: 'replace-text', officePath: '/body/p[3]', text: 'gamma final' },
    ], replace)
    expect(texts(root)).toEqual(['after A two', 'after A one', 'before B', 'beta final', 'gamma final'])
  })

  it('rejects an invalid later reference before invoking any paragraph replacement', () => {
    const root = document(paragraph('alpha'))
    const edit = vi.fn(replace)
    expect(() =>{  applyDocumentMutations(root, [
      { type: 'replace-text', officePath: '/body/p[1]', text: 'edited' },
      { type: 'remove', officePath: '/body/p[2]' },
    ], edit) }).toThrow('INVALID_OFFICE_PATH')
    expect(edit).not.toHaveBeenCalled()
    expect(texts(root)).toEqual(['alpha'])
  })

  it.each<EngineMutation>([
    { type: 'replace-text', officePath: '/body/p[1]', text: 'gone' },
    { type: 'remove', officePath: '/body/p[1]' },
    { type: 'insert-paragraph', after: '/body/p[1]', text: 'after gone' },
    { type: 'insert-paragraph', before: '/body/p[1]', text: 'before gone' },
  ])('rejects $type on an original node removed earlier', (mutation) => {
    const root = document(paragraph('alpha') + paragraph('beta'))
    expect(() =>{  applyDocumentMutations(root, [{ type: 'remove', officePath: '/body/p[1]' }, mutation], replace) })
      .toThrow('INVALID_OFFICE_TARGET')
    expect(texts(root)).toEqual(['beta'])
  })

  it('rejects a table descendant after removal of its original ancestor', () => {
    const root = document(`<w:tbl><w:tr><w:tc>${paragraph('cell')}</w:tc></w:tr></w:tbl>`)
    expect(() =>{  applyDocumentMutations(root, [
      { type: 'remove', officePath: '/body/tbl[1]' },
      { type: 'replace-text', officePath: '/body/tbl[1]/tr[1]/tc[1]/p[1]', text: 'gone' },
    ], replace) }).toThrow('INVALID_OFFICE_TARGET')
  })

  it('inserts beside a nested paragraph and resolves later references in the same original cell', () => {
    const root = document(`<w:tbl><w:tr><w:tc>${paragraph('one')}${paragraph('two')}</w:tc></w:tr></w:tbl>`)
    applyDocumentMutations(root, [
      { type: 'insert-paragraph', after: '/body/tbl[1]/tr[1]/tc[1]/p[1]', text: 'inserted' },
      { type: 'replace-text', officePath: '/body/tbl[1]/tr[1]/tc[1]/p[2]', text: 'two edited' },
    ], replace)
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
    { type: 'insert-paragraph', after: '/body/tbl[1]/tr[1]', text: 'invalid table child' },
    { type: 'insert-paragraph', before: '/body/tbl[1]/tr[1]/tc[1]', text: 'invalid row child' },
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
    { type: 'insert-paragraph', text: 'bad', after: '/body/p[1]', before: '/body/p[1]' },
    { type: 'insert-paragraph', text: 'bad', after: '/body/p[1]', index: 0 },
  ])('rejects invalid insertion positions: $index $after $before', (mutation) => {
    const root = document(paragraph('alpha'))
    expect(() =>{  applyDocumentMutations(root, [mutation], replace) }).toThrow('INVALID_INSERT_POSITION')
    expect(texts(root)).toEqual(['alpha'])
  })

  it('prevents removing the body container and propagates paragraph editor failures', () => {
    const root = document(paragraph('alpha'))
    expect(() =>{  applyDocumentMutations(root, [{ type: 'remove', officePath: '/body' }], replace) }).toThrow('INVALID_OFFICE_TARGET')
    expect(() =>{  applyDocumentMutations(root, [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }], () => {
      throw new Error('paragraph blocked')
    }) }).toThrow('paragraph blocked')
    expect(texts(root)).toEqual(['alpha'])
  })

  it('rejects replacement text addressed to a table container', () => {
    const root = document('<w:tbl/>')
    const edit = vi.fn(replace)
    expect(() => {
      applyDocumentMutations(root, [{ type: 'replace-text', officePath: '/body/tbl[1]', text: 'bad' }], edit)
    }).toThrow('INVALID_OFFICE_TARGET')
    expect(edit).not.toHaveBeenCalled()
  })

  it('resolves one explicit style for all inserted paragraphs before changing the body', () => {
    const root = document('')
    const resolveStyle = vi.fn(() => 'Heading1')
    applyBatch(root, [{ type: 'insert-paragraph', text: 'one\ntwo', style: 'Heading 1' }], replace, resolveStyle)
    expect(resolveStyle).toHaveBeenCalledExactlyOnceWith('Heading 1')
    expect(Array.from(root.getElementsByTagNameNS(WORD_NS, 'pStyle')).map(node => node.getAttributeNS(WORD_NS, 'val')))
      .toEqual(['Heading1', 'Heading1'])
    expect(() =>{  applyBatch(root, [{ type: 'insert-paragraph', text: 'bad', style: 'Unknown' }], replace, () => {
      throw new Error('style does not exist')
    }) }).toThrow('style does not exist')
    expect(texts(root)).toEqual(['one', 'two'])
  })
})
