import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { bindMutationTargets, resolveOfficePath } from '../src/office-path.ts'

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const WORD_ID_NS = 'http://schemas.microsoft.com/office/word/2010/wordml'
const document = (body: string) => new DOMParser().parseFromString(
  `<w:document xmlns:w="${WORD_NS}" xmlns:w14="${WORD_ID_NS}"><w:body>${body}</w:body></w:document>`,
  'application/xml',
).documentElement!
const paragraph = (text: string, id = '') => `<w:p${id === '' ? '' : ` w14:paraId="${id}"`}><w:r><w:t>${text}</w:t></w:r></w:p>`

describe('original OfficeCLI path bindings', () => {
  it('retains original targets after earlier paragraphs are split, inserted, and removed', () => {
    const root = document(paragraph('alpha') + paragraph('beta') + paragraph('gamma'))
    const targets = bindMutationTargets(root, [
      { type: 'replace-text', officePath: '/body/p[1]', text: 'first\ninserted', paragraphs: [{ text: 'first' }, { text: 'inserted' }] },
      { type: 'insert-paragraph', after: '/body/p[1]', text: 'another' },
      { type: 'insert-paragraph', before: '/body/p[2]', text: 'before beta' },
      { type: 'replace-text', officePath: '/body/p[2]', text: 'beta edited' },
      { type: 'remove', officePath: '/body/p[3]' },
    ])
    const alpha = targets.get('/body/p[1]')!
    const beta = targets.get('/body/p[2]')!
    const gamma = targets.get('/body/p[3]')!
    const body = alpha.parentNode!
    body.insertBefore(alpha.cloneNode(true), beta)
    body.insertBefore(alpha.cloneNode(true), beta)
    body.insertBefore(alpha.cloneNode(true), beta)
    body.removeChild(alpha)
    expect(targets.size).toBe(3)
    expect(beta.textContent).toBe('beta')
    expect(gamma.textContent).toBe('gamma')
    expect(beta).toBe(resolveOfficePath(root, '/body/p[4]'))
    expect(gamma).toBe(resolveOfficePath(root, '/body/p[5]'))
    expect(targets.get('/body/p[1]')?.parentNode).toBeNull()
  })

  it('binds nested table paragraphs independently of identical body text and sibling tables', () => {
    const table = `<w:tbl><w:tr><w:tc>${paragraph('same')}</w:tc></w:tr></w:tbl>`
    const root = document(paragraph('same') + table + table)
    const targets = bindMutationTargets(root, [
      { type: 'remove', officePath: '/body/tbl[1]' },
      { type: 'replace-text', officePath: '/document/body/tbl[2]/tr[1]/tc[1]/p[1]', text: 'edited' },
    ])
    const firstTable = targets.get('/body/tbl[1]')!
    const secondCell = targets.get('/document/body/tbl[2]/tr[1]/tc[1]/p[1]')!
    firstTable.parentNode!.removeChild(firstTable)
    expect(secondCell).toBe(resolveOfficePath(root, '/body/tbl[1]/tr[1]/tc[1]/p[1]'))
    expect(secondCell).not.toBe(resolveOfficePath(root, '/body/p[1]'))
  })

  it.each(['AB12', "'AB12'", '"AB12"'])('resolves paraId %s and numeric aliases to the same original element', (id) => {
    const root = document(paragraph('same') + paragraph('same', 'AB12'))
    const byId = resolveOfficePath(root, `/body/p[@paraId=${id}]`)
    expect(byId).toBe(resolveOfficePath(root, '/document/body/p[2]'))
    expect(resolveOfficePath(root, '/body')).toBe(byId.parentNode)
  })

  it('does not require an anchor for append or explicit-index insertion', () => {
    const root = document('')
    expect(bindMutationTargets(root, [
      { type: 'insert-paragraph', text: 'append' },
      { type: 'insert-paragraph', text: 'index', index: 0 },
    ]).size).toBe(0)
  })

  it.each([
    '', '/', '/document', '/header[1]/p[1]', '/bodyish', '/body/', '/body//p[1]',
    '/body/p[0]', '/body/p[3]', '/body/p[-1]', '/body/p[1.5]', '/body/p',
    '/body/p[@paraId=MISSING]', '/body/p[@paraId="AB12\']', '/body[@paraId=AB12]',
    '/body/p[1]/r[1]', '/body/sdt[1]',
  ])('rejects missing, ambiguous, or unsupported address %s', (path) => {
    expect(() => resolveOfficePath(document(paragraph('one') + paragraph('two', 'AB12')), path))
      .toThrow('INVALID_OFFICE_PATH')
  })

  it('rejects duplicate paraIds and wrong XML namespaces', () => {
    expect(() => resolveOfficePath(document(paragraph('one', 'AB12') + paragraph('two', 'AB12')), '/body/p[@paraId=AB12]'))
      .toThrow('INVALID_OFFICE_PATH')
    const foreignRoot = new DOMParser().parseFromString('<document><body><p/></body></document>', 'application/xml').documentElement!
    expect(() => resolveOfficePath(foreignRoot, '/body/p[1]')).toThrow('INVALID_OFFICE_PATH')
    const wrongName = new DOMParser().parseFromString(`<w:body xmlns:w="${WORD_NS}"/>`, 'application/xml').documentElement!
    expect(() => resolveOfficePath(wrongName, '/body')).toThrow('INVALID_OFFICE_PATH')
    const root = document(`<x:p xmlns:x="urn:foreign"/>${paragraph('one')}`)
    expect(resolveOfficePath(root, '/body/p[1]').textContent).toBe('one')
    expect(() => resolveOfficePath(root, '/body/p[2]')).toThrow('INVALID_OFFICE_PATH')
  })
})
