import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DOMParser, XMLSerializer, type Element as XmlElement } from '@xmldom/xmldom'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfficeCliDocumentEngine, OfficeCliError, officeCliBin } from '../src/index.ts'

interface Reply {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  lossy?: boolean
}

const successfulBatch = () => ({
  results: [{ index: 0, success: true, output: 'raw-set replace applied' }],
  summary: { total: 1, executed: 1, succeeded: 1, failed: 0, skipped: 0 },
})

const read = (text: string, lossy = false): SubprocessOutputRead => ({
  text,
  nextOffset: Buffer.byteLength(text),
  lossy,
})

const handle = (reply: Reply): SubprocessHandle => ({
  pid: 101,
  stdin: undefined,
  stdout: undefined,
  stderr: undefined,
  collected: {
    stdout: { readFrom: () => read(reply.stdout ?? '', reply.lossy) },
    stderr: { readFrom: () => read(reply.stderr ?? '') },
  },
  done: Promise.resolve({
    exitCode: reply.exitCode === undefined ? 0 : reply.exitCode,
    signal: reply.exitCode === null ? 'SIGTERM' : null,
  }),
  terminate: () => {},
  waitForExit: () => Promise.resolve(true),
})

function fixture(respond: (spec: SubprocessSpawnSpec) => Reply) {
  const ctx = new Context()
  const calls: SubprocessSpawnSpec[] = []
  const batches: Array<{ command: string; xml: string; input: string }> = []
  ctx.provide('subprocess', {
    resolveExecutable: vi.fn(async (command: string) => `C:\\bin\\${command}.exe`),
    spawn: vi.fn((spec: SubprocessSpawnSpec) => {
      calls.push(spec)
      if (spec.argv.includes('--input')) {
        const input = spec.argv[spec.argv.indexOf('--input') + 1]!
        const commands = JSON.parse(readFileSync(input, 'utf8')) as Array<{ command: string; xml: string }>
        batches.push(...commands.map(command => ({ ...command, input })))
      }
      const reply = respond(spec)
      if (spec.argv.includes('batch') && reply.stdout === undefined) {
        return handle({ ...reply, stdout: JSON.stringify({ data: successfulBatch() }) })
      }
      if (spec.argv.includes('/styles') && reply.stdout === undefined) {
        return handle({ ...reply, stdout: JSON.stringify({ data: '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
          + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>'
          + '<w:style w:type="paragraph" w:styleId="Normal"/></w:styles>' }) })
      }
      if (spec.argv.includes('raw') && reply.stdout === undefined) {
        return handle({ ...reply, stdout: JSON.stringify({ data:
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
          + '<w:p><w:r><w:t>original</w:t></w:r></w:p><w:p><w:r><w:t>original</w:t></w:r></w:p><w:p><w:r><w:t>third</w:t></w:r></w:p></w:body></w:document>',
        }) })
      }
      return handle(spec.argv.includes('get') && reply.stdout === undefined
        ? { ...reply, stdout: JSON.stringify({ data: { type: 'paragraph', text: 'original', childCount: 0, children: [] } }) }
        : reply)
    }),
  } as never)
  const engine = new OfficeCliDocumentEngine(ctx, {
    command: 'officecli',
    timeoutMs: 10_000,
    outputMaxBytes: 1_000_000,
    terminateGraceMs: 1_000,
  })
  return { ctx, calls, engine, batches }
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const documentXml = (body: string) => '<w:document xmlns:w="' + W + '"><w:body>' + body + '</w:body></w:document>'
const paragraphXml = (text: string) => '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>'
const xmlFixture = (body: string) => fixture(spec => spec.argv.includes('/document')
  ? { stdout: JSON.stringify({ data: documentXml(body) }) } : {})
const writtenBody = (test: ReturnType<typeof fixture>) => new DOMParser().parseFromString(test.batches[0]!.xml, 'application/xml').documentElement!
const childElements = (node: XmlElement) => Array.from(node.childNodes)
  .filter((child): child is XmlElement => child.nodeType === child.ELEMENT_NODE)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OfficeCliDocumentEngine', () => {
  it('reports health through the managed subprocess seam', async () => {
    const ready = fixture(() => ({ stdout: 'officecli 1.0.145\n' }))
    await expect(ready.engine.health()).resolves.toMatchObject({ status: 'ready', version: '1.0.145' })
    expect(ready.calls[0]?.argv).toEqual(['C:\\bin\\officecli.exe', '--version'])
    expect(ready.calls[0]?.env).toMatchObject({
      OFFICECLI_SKIP_UPDATE: '1',
      OFFICECLI_RESIDENT_FLUSH: 'each',
    })

    const unavailable = fixture(() => ({ stderr: 'native load failed', exitCode: 1 }))
    await expect(unavailable.engine.health()).resolves.toEqual({
      status: 'unavailable',
      detail: 'native load failed',
    })
  })

  it('parses nested Office paths and leaves the resident document running', async () => {
    const { calls, engine } = fixture(spec => spec.argv.includes('text')
      ? { stdout: '[/document/body/p[1]] 第一段\n[/document/body/tbl[1]/tr[1]/tc[1]/p[1]] 单元格\nnoise' }
      : {})
    await expect(engine.readTextNodes('D:\\paper.docx')).resolves.toEqual([
      { officePath: '/document/body/p[1]', text: '第一段', kind: 'paragraph' },
      { officePath: '/document/body/tbl[1]/tr[1]/tc[1]/p[1]', text: '单元格', kind: 'table' },
    ])
    expect(calls.map(call => call.argv.slice(1, 3))).toEqual([['view', 'D:\\paper.docx']])
  })

  it('ignores malformed text records and classifies non-paragraph nodes', async () => {
    const { engine } = fixture(spec => spec.argv.includes('text')
      ? { stdout: '[bad] ignored\n[/document/body/sdt[1]] field\n[/unterminated\n' }
      : {})
    await expect(engine.readTextNodes('paper.docx')).resolves.toEqual([
      { officePath: '/document/body/sdt[1]', text: 'field', kind: 'unknown' },
    ])
  })

  it('applies ordered structural mutations with one document read and one command-file batch', async () => {
    const test = xmlFixture(paragraphXml('alpha') + paragraphXml('beta') + paragraphXml('gamma'))
    await test.engine.applyMutations('paper.docx', [
      { type: 'replace-text', officePath: '/body/p[1]', text: 'edited' },
      { type: 'insert-paragraph', after: '/body/p[1]', text: 'inserted' },
      { type: 'replace-text', officePath: '/body/p[2]', text: 'beta edited' },
      { type: 'remove', officePath: '/body/p[3]' },
    ])
    expect(childElements(writtenBody(test)).map(node => node.textContent)).toEqual(['edited', 'inserted', 'beta edited'])
    expect(test.calls.map(call => call.argv[1])).toEqual(['raw', 'batch', 'save'])
    expect(test.batches).toHaveLength(1)
    expect(test.batches[0]).toMatchObject({ command: 'raw-set', part: '/word/document.xml', xpath: '/w:document/w:body', action: 'replace' })
    expect(existsSync(test.batches[0]!.input)).toBe(false)
    expect(test.calls.find(call => call.argv.includes('batch'))?.argv).toContain('--input')
  })

  it('keeps command arguments bounded for a large multi-paragraph batch', async () => {
    const test = xmlFixture(Array.from({ length: 70 }, (_, index) => paragraphXml(`paragraph ${index}`)).join(''))
    await test.engine.applyMutations('paper.docx', Array.from({ length: 70 }, (_, index) => ({
      type: 'replace-text' as const, officePath: `/body/p[${index + 1}]`, text: `edited ${index} ${'x'.repeat(800)}`,
    })))
    expect(writtenBody(test).getElementsByTagNameNS(W, 'p')).toHaveLength(70)
    expect(test.batches[0]!.xml.length).toBeGreaterThan(32_768)
    expect(test.calls.map(call => call.argv[1])).toEqual(['raw', 'batch', 'save'])
    expect(test.calls.every(call => call.argv.join(' ').length < 1000)).toBe(true)
  })

  it('does not read or write an empty mutation batch', async () => {
    const test = fixture(() => ({}))
    await test.engine.applyMutations('paper.docx', [])
    expect(test.calls).toEqual([])
  })

  it('writes explicit run overrides and retains opaque original run metadata', async () => {
    const test = xmlFixture('<w:p><w:r><w:rPr><w:lang w:val="en-US"/><w:vertAlign w:val="subscript"/></w:rPr><w:t>original</w:t></w:r></w:p>')
    await test.engine.applyMutations('paper.docx', [{
      type: 'replace-text', officePath: '/body/p[1]', text: 'bold rest',
      runs: [{ text: 'bold', bold: true, size: '16pt', font: 'Arial', color: '#ff0000' }, { text: ' rest', italic: true, underline: false }],
    }])
    const body = writtenBody(test)
    expect(body.textContent).toBe('bold rest')
    expect(body.getElementsByTagNameNS(W, 'lang')[0]?.getAttributeNS(W, 'val')).toBe('en-US')
    expect(body.getElementsByTagNameNS(W, 'vertAlign')[0]?.getAttributeNS(W, 'val')).toBe('subscript')
    expect(body.getElementsByTagNameNS(W, 'sz')[0]?.getAttributeNS(W, 'val')).toBe('32')
    expect(body.getElementsByTagNameNS(W, 'szCs')[0]?.getAttributeNS(W, 'val')).toBe('32')
    expect(body.getElementsByTagNameNS(W, 'rFonts')[0]?.getAttributeNS(W, 'ascii')).toBe('Arial')
    expect(body.getElementsByTagNameNS(W, 'u')[0]?.getAttributeNS(W, 'val')).toBe('none')
  })

  it('preserves soft breaks and tabs when reconstructing multiple runs', async () => {
    const test = fixture(() => ({}))
    await test.engine.applyMutations('paper.docx', [{
      type: 'replace-text', officePath: '/body/p[1]', text: 'first\vnextlast\vline\tend',
      runs: [{ text: 'first\vnext', bold: true }, { text: 'last\vline\tend', italic: true }],
    }])
    const paragraph = writtenBody(test).getElementsByTagNameNS(W, 'p')[0]!
    expect(paragraph.getElementsByTagNameNS(W, 'br')).toHaveLength(2)
    expect(paragraph.getElementsByTagNameNS(W, 'tab')).toHaveLength(1)
    expect(writtenBody(test).getElementsByTagNameNS(W, 'p')).toHaveLength(3)
  })

  it('splits beside its original node while preserving paragraph properties and later targets', async () => {
    const test = xmlFixture('<w:p><w:pPr><w:keepNext/><w:spacing w:line="360" w:lineRule="auto"/><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr></w:pPr>'
      + '<w:r><w:rPr><w:lang w:val="zh-CN"/></w:rPr><w:t>original</w:t></w:r></w:p>' + paragraphXml('tail'))
    await test.engine.applyMutations('paper.docx', [
      { type: 'replace-text', officePath: '/body/p[1]', text: 'one\ntwo', paragraphs: [
        { text: 'one', format: { align: 'center' } },
        { text: 'two', runs: [{ text: 'two', underline: false }], format: { indent: '24pt' } },
      ] },
      { type: 'replace-text', officePath: '/body/p[2]', text: 'tail edited' },
    ])
    const paragraphs = Array.from(writtenBody(test).getElementsByTagNameNS(W, 'p'))
    expect(paragraphs.map(node => node.textContent)).toEqual(['one', 'two', 'tail edited'])
    expect(paragraphs.slice(0, 2).map(node => node.getElementsByTagNameNS(W, 'keepNext').length)).toEqual([1, 1])
    expect(paragraphs[1]?.getElementsByTagNameNS(W, 'ind')[0]?.getAttributeNS(W, 'left')).toBe('480')
    expect(paragraphs[1]?.getElementsByTagNameNS(W, 'spacing')[0]?.getAttributeNS(W, 'line')).toBe('360')
    expect(paragraphs[1]?.getElementsByTagNameNS(W, 'lang')[0]?.getAttributeNS(W, 'val')).toBe('zh-CN')
  })

  it('resolves paragraph style names once while preserving unchanged text XML', async () => {
    const test = xmlFixture('<w:p><w:r w:rsidR="AABB"><w:rPr><w:lang w:val="en-US"/></w:rPr><w:t>original</w:t></w:r></w:p>')
    await test.engine.applyMutations('paper.docx', [
      { type: 'replace-text', officePath: '/body/p[1]', text: 'original', paragraphs: [{ text: 'original', format: { style: 'Heading 1', lineSpacing: '2x' } }] },
      { type: 'insert-paragraph', text: 'inserted', style: 'normal' },
    ])
    const paragraphs = Array.from(writtenBody(test).getElementsByTagNameNS(W, 'p'))
    expect(paragraphs.map(node => node.getElementsByTagNameNS(W, 'pStyle')[0]?.getAttributeNS(W, 'val'))).toEqual(['Heading1', 'Normal'])
    expect(paragraphs[0]?.getElementsByTagNameNS(W, 'r')[0]?.getAttributeNS(W, 'rsidR')).toBe('AABB')
    expect(test.calls.map(call => call.argv[1])).toEqual(['raw', 'raw', 'batch', 'save'])
    expect(test.calls.filter(call => call.argv.includes('/styles'))).toHaveLength(1)
  })

  it('rejects unknown paragraph style names before writing', async () => {
    const test = fixture(() => ({}))
    await expect(test.engine.applyMutations('paper.docx', [{ type: 'insert-paragraph', text: 'inserted', style: 'Missing' }]))
      .rejects.toThrow('UNKNOWN_PARAGRAPH_STYLE')
    expect(test.batches).toEqual([])
  })

  it('rejects an insertion into a table row before writing any batch', async () => {
    const test = xmlFixture('<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>')
    await expect(test.engine.applyMutations('paper.docx', [
      { type: 'insert-paragraph', before: '/body/tbl[1]/tr[1]/tc[1]', text: 'invalid' },
    ])).rejects.toThrow('INVALID_INSERT_POSITION')
    expect(test.batches).toEqual([])
    expect(test.calls.map(call => call.argv[1])).toEqual(['raw'])
  })

  it('reads defined paragraph style IDs and display names without changing the document', async () => {
    const test = fixture(spec => spec.argv.includes('/styles') ? { stdout: JSON.stringify({ data:
      '<w:styles xmlns:w="' + W + '"><w:style w:type="character" w:styleId="Emphasis"/>'
      + '<w:style w:type="paragraph"/><w:style w:type="paragraph" w:styleId=""/>'
      + '<w:style w:type="paragraph" w:styleId="a"><w:name w:val="Normal"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="2"><w:name w:val="Body Text Indent 2"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Custom"/>'
      + '<w:style w:type="paragraph" w:styleId="Blank"><w:name w:val=""/></w:style></w:styles>',
    }) } : {})
    await expect(test.engine.readParagraphStyles('paper.docx')).resolves.toEqual([
      { id: 'a', name: 'Normal' }, { id: '2', name: 'Body Text Indent 2' },
      { id: 'Custom', name: 'Custom' }, { id: 'Blank', name: 'Blank' },
    ])
    expect(test.calls.map(call => call.argv.slice(1))).toEqual([['raw', 'paper.docx', '/styles', '--json']])
    expect(test.batches).toEqual([])
  })

  it('prefers a selected exact style ID over colliding IDs and display names', async () => {
    const test = fixture(spec => spec.argv.includes('/styles') ? { stdout: JSON.stringify({ data:
      '<w:styles xmlns:w="' + W + '"><w:style w:type="paragraph" w:styleId="BODY"><w:name w:val="Upper"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="body"><w:name w:val="Lower"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Other"><w:name w:val="body"/></w:style></w:styles>',
    }) } : {})
    await test.engine.applyMutations('paper.docx', [
      { type: 'insert-paragraph', text: 'selected', style: 'body' },
      { type: 'insert-paragraph', text: 'by-name', style: 'upper' },
    ])
    expect(Array.from(writtenBody(test).getElementsByTagNameNS(W, 'pStyle')).map(style => style.getAttributeNS(W, 'val')))
      .toEqual(['body', 'BODY'])
  })

  it('rejects a malformed style catalog without returning choices', async () => {
    const test = fixture(() => ({ stdout: JSON.stringify({ data: '<w:document xmlns:w="' + W + '"/>' }) }))
    await expect(test.engine.readParagraphStyles('paper.docx')).rejects.toThrow()
  })

  it('returns no choices when the optional styles part is absent', async () => {
    const test = fixture(() => ({ stdout: JSON.stringify({ success: true, data: '(no styles)', message: '(no styles)' }) }))
    await expect(test.engine.readParagraphStyles('paper.docx')).resolves.toEqual([])
  })

  it('ignores non-paragraph and unidentified styles while allowing an existing style without a display name', async () => {
    const test = fixture(spec => spec.argv.includes('/styles') ? { stdout: JSON.stringify({ data:
      '<w:styles xmlns:w="' + W + '"><w:style w:type="character" w:styleId="Emphasis"/>'
      + '<w:style w:type="paragraph"/><w:style w:type="paragraph" w:styleId="Custom"/></w:styles>',
    }) } : {})
    await test.engine.applyMutations('paper.docx', [{ type: 'insert-paragraph', text: 'inserted', style: 'custom' }])
    expect(writtenBody(test).getElementsByTagNameNS(W, 'pStyle')[0]?.getAttributeNS(W, 'val')).toBe('Custom')
  })

  it.each([
    '<w:sym w:font="Symbol" w:char="F041"/>', '<w:softHyphen/>', '<w:instrText>PAGE</w:instrText>',
    '<w:fldChar w:fldCharType="begin"/>', '<w:footnoteReference w:id="1"/>',
  ])('rejects text objects that the editor cannot project: %s', async (inline) => {
    const test = xmlFixture('<w:p><w:r><w:t>before</w:t>' + inline + '<w:t>after</w:t></w:r></w:p>')
    await expect(test.engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }]))
      .rejects.toThrow('UNSUPPORTED_DOCUMENT_CONTENT')
    expect(test.calls.map(call => call.argv[1])).toEqual(['raw'])
    expect(test.batches).toEqual([])
  })

  it.each(['<w:br w:type="page"/>', '<w:br w:type="column"/>', '<w:lastRenderedPageBreak/>'])
  ('retains non-text break markers omitted from the projected text: %s', async (inline) => {
    const test = xmlFixture('<w:p><w:r><w:t>before</w:t>' + inline + '<w:t>after</w:t></w:r></w:p>')
    await test.engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'before edited after' }])
    expect(new XMLSerializer().serializeToString(writtenBody(test))).toContain(inline)
  })

  it('retains a clear-bearing soft break unless the replacement text explicitly removes it', async () => {
    const body = '<w:p><w:r><w:t>before</w:t><w:br w:clear="all"/><w:t>after</w:t></w:r></w:p>'
    const retained = xmlFixture(body)
    await retained.engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'before\vafter edited' }])
    expect(new XMLSerializer().serializeToString(writtenBody(retained))).toContain('<w:br w:clear="all"/>')
    const removed = xmlFixture(body)
    await removed.engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'beforeafter edited' }])
    expect(writtenBody(removed).getElementsByTagNameNS(W, 'br')).toHaveLength(0)
  })

  it('accepts soft breaks and tabs inside a nested table paragraph', async () => {
    const test = xmlFixture('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>before</w:t><w:br/><w:tab/><w:t>after</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
    await test.engine.applyMutations('paper.docx', [{
      type: 'replace-text', officePath: '/body/tbl[1]/tr[1]/tc[1]/p[1]', text: 'before\v\tafter edited',
    }])
    const body = writtenBody(test)
    expect(body.getElementsByTagNameNS(W, 'tc')[0]?.textContent).toBe('beforeafter edited')
    expect(body.getElementsByTagNameNS(W, 'br')).toHaveLength(1)
    expect(body.getElementsByTagNameNS(W, 'tab')).toHaveLength(1)
    expect(test.calls.map(call => call.argv[1])).toEqual(['raw', 'batch', 'save'])
  })

  it.each(['vertAlign', 'strike', 'dstrike', 'vanish', 'rStyle', 'rPrChange', 'lang', 'rtl'])
  ('retains opaque run property %s while changing text', async (property) => {
    const test = xmlFixture('<w:p><w:r><w:rPr><w:' + property + ' w:val="detail"/></w:rPr><w:t>original</w:t></w:r></w:p>')
    await test.engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }])
    expect(writtenBody(test).getElementsByTagNameNS(W, property)[0]?.getAttributeNS(W, 'val')).toBe('detail')
  })

  it.each([
    '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="SimSun"/>',
    '<w:rFonts w:asciiTheme="minorHAnsi"/>', '<w:sz w:val="24"/><w:szCs w:val="40"/>',
    '<w:szCs w:val="40"/>', '<w:color w:val="4472C4" w:themeColor="accent1"/>',
    '<w:u w:val="double" w:color="FF0000"/>', '<w:b w:val="0"/><w:bCs/>',
  ])('retains script and theme details while changing unrelated paragraph text: %s', async (properties) => {
    const test = xmlFixture('<w:p><w:r><w:rPr>' + properties + '</w:rPr><w:t>original</w:t></w:r></w:p>')
    await test.engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }])
    expect(new XMLSerializer().serializeToString(writtenBody(test))).toContain(properties)
  })

  it.each(['<broken>', '', null, '<document/>', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'])
  ('rejects unavailable or malformed document XML before writing: %j', async (data) => {
    const test = fixture(spec => spec.argv.includes('raw') ? { stdout: JSON.stringify({ data }) } : {})
    await expect(test.engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }]))
      .rejects.toThrow()
    expect(test.calls.map(call => call.argv[1])).toEqual(['raw'])
    expect(test.batches).toEqual([])
  })

  it('removes its temporary command file after an OfficeCLI batch failure', async () => {
    const test = fixture(spec => spec.argv.includes('batch') ? { exitCode: 1, stderr: 'batch rejected' } : {})
    await expect(test.engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }]))
      .rejects.toThrow('batch rejected')
    expect(test.calls.map(call => call.argv[1])).toEqual(['raw', 'batch'])
    expect(existsSync(test.batches[0]!.input)).toBe(false)
  })

  it.each([
    { results: successfulBatch().results },
    { ...successfulBatch(), summary: null },
    ...([['total', 2], ['executed', 0], ['succeeded', 0], ['failed', 1], ['skipped', 1]] as const).map(([key, value]) => ({
      ...successfulBatch(), summary: { ...successfulBatch().summary, [key]: value },
    })),
    { ...successfulBatch(), results: undefined },
    { ...successfulBatch(), results: [] },
    { ...successfulBatch(), results: [...successfulBatch().results, ...successfulBatch().results] },
    { ...successfulBatch(), results: [null] },
    { ...successfulBatch(), results: [{ index: 1, success: true }] },
    { ...successfulBatch(), results: [{ index: 0, success: false, error: 'raw-set failed' }] },
    { ...successfulBatch(), results: [{ index: 0, skipped: true }] },
  ])('rejects an unsuccessful or incomplete batch response despite exit code zero: %j', async (data) => {
    const test = fixture(spec => spec.argv.includes('batch') ? { stdout: JSON.stringify({ data }) } : {})
    await expect(test.engine.applyMutations('paper.docx', [{ type: 'replace-text', officePath: '/body/p[1]', text: 'edited' }]))
      .rejects.toThrow('OfficeCLI did not apply the complete document batch')
    expect(test.calls.map(call => call.argv[1])).toEqual(['raw', 'batch'])
    expect(existsSync(test.batches[0]!.input)).toBe(false)
  })
  it('parses preview, inspection, and validation envelopes', async () => {
    const { engine } = fixture((spec) => {
      if (spec.argv.includes('html')) return { stdout: '<article>论文</article>' }
      if (spec.argv.includes('get')) return { stdout: '{"data":{"style":"正文"}}' }
      if (spec.argv.includes('validate')) return { stdout: '{"data":{"success":true,"issues":[]}}' }
      return {}
    })
    await expect(engine.previewHtml('paper.docx')).resolves.toBe('<article>论文</article>')
    await expect(engine.inspect('paper.docx', '/document/body/p[1]', 3)).resolves.toEqual({ style: '正文' })
    await expect(engine.validate('paper.docx')).resolves.toEqual({
      success: true,
      details: { success: true, issues: [] },
    })
  })

  it('uses validation exit status when no declared success exists', async () => {
    const empty = fixture(spec => spec.argv.includes('validate') ? { stderr: 'invalid', exitCode: 1 } : {})
    await expect(empty.engine.validate('paper.docx')).resolves.toEqual({
      success: false,
      details: { stderr: 'invalid' },
    })
    const primitiveData = fixture(spec => spec.argv.includes('get') ? { stdout: '{"data":null,"success":true}' } : {})
    await expect(primitiveData.engine.inspect('paper.docx', '/document')).resolves.toEqual({ data: null, success: true })
  })

  it('fails explicitly on truncated or malformed engine output', async () => {
    const truncated = fixture(spec => spec.argv.includes('html')
      ? { stdout: '<article>', lossy: true }
      : {})
    await expect(truncated.engine.previewHtml('paper.docx')).rejects.toThrow(OfficeCliError)

    const malformed = fixture(spec => spec.argv.includes('get')
      ? { stdout: 'not json' }
      : {})
    await expect(malformed.engine.inspect('paper.docx', '/document/body/p[1]')).rejects
      .toThrow('OfficeCLI returned invalid JSON')
  })

  it('rejects invalid deployment limits before publishing a usable Provider', () => {
    const ctx = new Context()
    expect(() => new OfficeCliDocumentEngine(ctx, {
      command: 'officecli',
      timeoutMs: 0,
      outputMaxBytes: 1,
      terminateGraceMs: 1,
    })).toThrow('timeoutMs must be a positive safe integer')
    expect(() => new OfficeCliDocumentEngine(new Context(), { timeoutMs: Number.NaN })).toThrow('timeoutMs must be a positive safe integer')
    expect(() => new OfficeCliDocumentEngine(new Context(), { cleanupTimeoutMs: 0 }))
      .toThrow('cleanupTimeoutMs must be a positive safe integer')
    expect(() => new OfficeCliDocumentEngine(new Context(), { residentIdleMs: 0 }))
      .toThrow('residentIdleMs must be a positive safe integer')
  })

  it('resolves every supported OfficeCLI manifest bin form', () => {
    expect(officeCliBin({ bin: 'cli.js' })).toBe('cli.js')
    expect(officeCliBin({ bin: { officecli: 'bin/officecli.js' } })).toBe('bin/officecli.js')
    expect(() => officeCliBin({ bin: {} })).toThrow('declares no officecli binary')
  })

  it('normalizes legacy converter configuration through Schemastery', () => {
    expect(OfficeCliDocumentEngine.Config({})).toMatchObject({
      cleanupTimeoutMs: 5_000,
      legacyDocTimeoutMs: 120_000,
      legacyDocOutputMaxBytes: 1024 * 1024,
      legacyDocTerminateGraceMs: 5_000,
    })
    expect(OfficeCliDocumentEngine.Config({ legacyDocPowerShellCommand: false }).legacyDocPowerShellCommand).toBe(false)
    expect(OfficeCliDocumentEngine.Config({ legacyDocPowerShellCommand: 'pwsh.exe' }).legacyDocPowerShellCommand).toBe('pwsh.exe')
    expect(() => OfficeCliDocumentEngine.Config({ legacyDocPowerShellCommand: 7 } as never)).toThrow()
  })

  it('uses the packaged launcher and caches executable resolution', async () => {
    const ctx = new Context()
    const calls: SubprocessSpawnSpec[] = []
    const resolveExecutable = vi.fn(async (command: string) => command)
    ctx.provide('subprocess', {
      resolveExecutable,
      spawn: (spec: SubprocessSpawnSpec) => {
        calls.push(spec)
        return handle({ stdout: 'officecli\n' })
      },
    } as never)
    const engine = new OfficeCliDocumentEngine(ctx, {})
    await engine.health()
    await engine.health()
    expect(resolveExecutable).toHaveBeenCalledTimes(1)
    expect(calls[0]?.argv[0]).toBe(process.execPath)
    expect(calls[0]?.argv[1]).toMatch(/officecli/u)
  })

  it('projects the host legacy-conversion capability through the structural engine extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paperai-officecli-method-'))
    const source = join(root, 'source.doc')
    const target = join(root, 'target.docx')
    await writeFile(source, 'source')
    try {
      const { calls, engine } = fixture((spec) => {
        if (spec.argv.some(argument => argument.endsWith('convert-legacy-doc.ps1'))) writeFileSync(target, 'docx')
        return {}
      })
      const result = await engine.normalizeLegacyDocument(source, target)
      await expect(readFile(source, 'utf8')).resolves.toBe('source')
      if (process.platform === 'win32') {
        expect(result).toEqual({ status: 'normalized' })
        expect(calls.at(-1)?.argv).toContain(target)
      } else {
        expect(result).toEqual({
          status: 'degraded',
          detail: `Legacy .doc conversion requires Windows and Microsoft Word; current platform is ${process.platform}`,
        })
        expect(calls).toHaveLength(0)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports empty health output and thrown non-Error diagnostics', async () => {
    const empty = fixture(() => ({ stdout: '   ' }))
    await expect(empty.engine.health()).resolves.toMatchObject({ status: 'ready' })
    const failed = fixture(() => ({ stderr: '', exitCode: 5 }))
    await expect(failed.engine.health()).resolves.toEqual({
      status: 'unavailable',
      detail: 'OfficeCLI returned a non-zero status',
    })

    const ctx = new Context()
    ctx.provide('subprocess', {
      resolveExecutable: async () => { throw 'resolution failed' },
      spawn: vi.fn(),
    } as never)
    const engine = new OfficeCliDocumentEngine(ctx, {})
    await expect(engine.health()).resolves.toEqual({ status: 'unavailable', detail: 'resolution failed' })

    const errorCtx = new Context()
    errorCtx.provide('subprocess', {
      resolveExecutable: async () => { throw new Error('executable lookup failed') },
      spawn: vi.fn(),
    } as never)
    const errorEngine = new OfficeCliDocumentEngine(errorCtx, {})
    await expect(errorEngine.health()).resolves.toEqual({ status: 'unavailable', detail: 'executable lookup failed' })
  })

  it('inserts at an explicit current body index', async () => {
    const test = fixture(() => ({}))
    await test.engine.applyMutations('paper.docx', [{ type: 'insert-paragraph', text: 'positioned', index: 1 }])
    expect(childElements(writtenBody(test)).map(node => node.textContent)).toEqual(['original', 'positioned', 'original', 'third'])
  })
  it('classifies OfficeCLI cancellation, timeout, and non-zero failures', async () => {
    const cancellation = new AbortController()
    const cancelledCtx = new Context()
    cancelledCtx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (_spec: SubprocessSpawnSpec) => {
        cancellation.abort()
        return handle({ exitCode: null })
      },
    } as never)
    const cancelled = new OfficeCliDocumentEngine(cancelledCtx, { command: 'officecli' })
    await expect(cancelled.previewHtml('paper.docx', cancellation.signal)).rejects.toThrow('cancelled')

    const timeoutCtx = new Context()
    timeoutCtx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (spec: SubprocessSpawnSpec) => spec.argv.includes('close')
        ? handle({})
        : {
          ...handle({}),
          done: new Promise(resolveDone => spec.signal?.addEventListener('abort', () => {
            resolveDone({ exitCode: null, signal: 'SIGTERM' })
          }, { once: true })),
        },
    } as never)
    const timedOut = new OfficeCliDocumentEngine(timeoutCtx, { command: 'officecli', timeoutMs: 1 })
    await expect(timedOut.previewHtml('paper.docx')).rejects.toThrow('timed out')

    for (const stderr of ['failed explicitly', '']) {
      const failed = fixture(spec => spec.argv.includes('html') ? { exitCode: 3, stderr } : {})
      await expect(failed.engine.previewHtml('paper.docx')).rejects.toThrow(
        stderr === '' ? 'exit code 3' : stderr,
      )
    }
  })

  it('releases a cancelled document with a fresh bounded close signal', async () => {
    const operations = [
      (engine: OfficeCliDocumentEngine, signal: AbortSignal) =>
        engine.inspect('paper.docx', '/document/body/p[1]', 2, signal),
      (engine: OfficeCliDocumentEngine, signal: AbortSignal) =>
        engine.applyMutations('paper.docx', [
          { type: 'replace-text', officePath: '/document/body/p[1]', text: 'changed' },
        ], signal),
      (engine: OfficeCliDocumentEngine, signal: AbortSignal) => engine.validate('paper.docx', signal),
    ]

    for (const operation of operations) {
      const controller = new AbortController()
      const calls: SubprocessSpawnSpec[] = []
      let cleanupSignal: AbortSignal | undefined
      const ctx = new Context()
      ctx.provide('subprocess', {
        resolveExecutable: async (command: string) => command,
        spawn: (spec: SubprocessSpawnSpec) => {
          calls.push(spec)
          if (spec.argv.includes('close')) {
            cleanupSignal = spec.signal
            return handle({})
          }
          controller.abort(new Error('caller cancelled'))
          return handle({ exitCode: null })
        },
      } as never)
      const engine = new OfficeCliDocumentEngine(ctx, {
        command: 'officecli',
        cleanupTimeoutMs: 25,
      })

      await expect(operation(engine, controller.signal)).rejects.toThrow('cancelled')
      await engine.release('paper.docx')
      expect(calls.at(-1)?.argv).toContain('close')
      expect(cleanupSignal).toBeDefined()
      expect(cleanupSignal).not.toBe(controller.signal)
      expect(cleanupSignal?.aborted).toBe(false)
    }
  })

  it('bounds independent close cleanup without replacing the caller cancellation', async () => {
    const controller = new AbortController()
    let cleanupSignal: AbortSignal | undefined
    const ctx = new Context()
    ctx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (spec: SubprocessSpawnSpec) => {
        if (!spec.argv.includes('close')) {
          controller.abort(new Error('caller cancelled'))
          return handle({ exitCode: null })
        }
        cleanupSignal = spec.signal
        return {
          ...handle({}),
          done: new Promise(resolveDone => spec.signal?.addEventListener('abort', () => {
            resolveDone({ exitCode: null, signal: 'SIGTERM' })
          }, { once: true })),
        }
      },
    } as never)
    const warning = vi.spyOn(ctx.logger, 'warn')
    const engine = new OfficeCliDocumentEngine(ctx, {
      command: 'officecli',
      cleanupTimeoutMs: 1,
    })

    await expect(engine.inspect('paper.docx', '/document', 1, controller.signal))
      .rejects.toThrow('cancelled')
    await engine.release('paper.docx')
    expect(cleanupSignal?.aborted).toBe(true)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('timed out after 1 ms'))
  })

  it('handles absent readers, stderr truncation, and close failures', async () => {
    const noReadersCtx = new Context()
    noReadersCtx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: () => ({ ...handle({}), collected: {} }),
    } as never)
    const noReaders = new OfficeCliDocumentEngine(noReadersCtx, { command: 'officecli' })
    await expect(noReaders.previewHtml('paper.docx')).resolves.toBe('')

    const stderrLossyCtx = new Context()
    stderrLossyCtx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: () => ({
        ...handle({}),
        collected: {
          stdout: { readFrom: () => read('') },
          stderr: { readFrom: () => read('truncated', true) },
        },
      }),
    } as never)
    const stderrLossy = new OfficeCliDocumentEngine(stderrLossyCtx, { command: 'officecli' })
    await expect(stderrLossy.previewHtml('paper.docx')).rejects.toThrow('output exceeded')

    const closeFailure = fixture(spec => spec.argv.includes('close') ? { lossy: true } : { stdout: '<p />' })
    const warning = vi.spyOn(closeFailure.ctx.logger, 'warn')
    await expect(closeFailure.engine.previewHtml('paper.docx')).resolves.toBe('<p />')
    await closeFailure.engine.release('paper.docx')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('could not close'))
  })

  it('closes an idle resident after residentIdleMs and never twice for one release', async () => {
    vi.useFakeTimers()
    try {
      const { calls, engine } = fixture(() => ({ stdout: '<p />' }))
      await engine.previewHtml('paper.docx')
      expect(calls.map(call => call.argv[1])).toEqual(['view'])
      await vi.advanceTimersByTimeAsync(2_000)
      expect(calls.map(call => call.argv[1])).toEqual(['view', 'close'])
      await engine.previewHtml('paper.docx')
      await engine.release('paper.docx')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls.map(call => call.argv[1])).toEqual(['view', 'close', 'view', 'close'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('release without a resident issues no close', async () => {
    const { calls, engine } = fixture(() => ({ stdout: '<p />' }))
    await engine.release('paper.docx')
    expect(calls).toEqual([])
    await engine.previewHtml('paper.docx')
    await engine.release('paper.docx')
    await engine.release('paper.docx')
    expect(calls.map(call => call.argv[1])).toEqual(['view', 'close'])
  })

  it('releases every retained document when the Provider context is disposed', async () => {
    const ctx = new Context()
    const calls: SubprocessSpawnSpec[] = []
    ctx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (spec: SubprocessSpawnSpec) => {
        calls.push(spec)
        return handle({ stdout: '<article />' })
      },
    } as never)
    await ctx.plugin(OfficeCliDocumentEngine, { command: 'officecli' })
    await ctx.documentEngine.previewHtml('one.docx')
    await ctx.documentEngine.previewHtml('two.docx')
    await ctx.fiber.dispose()
    expect(calls.filter(call => call.argv.includes('close')).map(call => call.argv[2])).toEqual(['one.docx', 'two.docx'])
  })

  it('serializes overlapping operations and releases only the current lease tail', async () => {
    const ctx = new Context()
    let releaseFirst: (() => void) | undefined
    let viewCount = 0
    const calls: string[][] = []
    ctx.provide('subprocess', {
      resolveExecutable: async (command: string) => command,
      spawn: (spec: SubprocessSpawnSpec) => {
        calls.push([...spec.argv])
        if (spec.argv.includes('html') && viewCount++ === 0) {
          return {
            ...handle({ stdout: 'first' }),
            done: new Promise((resolveDone) => {
              releaseFirst = () => { resolveDone({ exitCode: 0, signal: null }) }
            }),
          }
        }
        return handle({ stdout: spec.argv.includes('html') ? 'second' : '' })
      },
    } as never)
    const engine = new OfficeCliDocumentEngine(ctx, { command: 'officecli' })
    const first = engine.previewHtml('same.docx')
    const second = engine.previewHtml('same.docx')
    await vi.waitFor(() => { expect(releaseFirst).toBeTypeOf('function') })
    expect(calls.filter(argv => argv.includes('html'))).toHaveLength(1)
    releaseFirst?.()
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
  })
})
